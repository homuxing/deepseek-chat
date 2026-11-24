import type { Bindings } from './types.js'

type SocketIdentity = { userId: string; tokenHash: string; authVersion: number }

/** 每个账号独立的推送连接；只传递更新通知，内容由已鉴权的存储接口读取。 */
export class HistorySync {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Bindings
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/notify') {
      await this.broadcast()
      return new Response(null, { status: 204 })
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('需要同步连接', { status: 400 })
    }
    const identity: SocketIdentity = {
      userId: request.headers.get('X-Sync-User') ?? '',
      tokenHash: request.headers.get('X-Sync-Token') ?? '',
      authVersion: Number(request.headers.get('X-Sync-Version')),
    }
    if (!identity.userId || !identity.tokenHash || !Number.isSafeInteger(identity.authVersion)) {
      return new Response('同步身份无效', { status: 401 })
    }
    const pair = new WebSocketPair()
    pair[1].serializeAttachment(identity)
    this.state.acceptWebSocket(pair[1])
    pair[1].send(JSON.stringify({ type: 'ready' }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private async broadcast(message: unknown = { type: 'changed' }): Promise<void> {
    const sockets = this.state.getWebSockets()
    // 推送前重新检查每条连接，密码重置、退出和会话过期后不继续接收通知。
    for (const socket of sockets) {
      try {
        const identity = socket.deserializeAttachment() as SocketIdentity | null
        if (!identity) {
          socket.close(1008, '登录状态已变更')
          continue
        }
        const session = await this.env.DB.prepare(
          `SELECT 1 AS valid FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.user_id = ? AND s.auth_version = ?
           AND s.auth_version = u.auth_version AND u.status = 'active'
           AND MIN(s.expires_at, s.absolute_expires_at) > ?`
        )
          .bind(identity.tokenHash, identity.userId, identity.authVersion, Date.now())
          .first()
        if (!session) {
          socket.close(1008, '登录状态已变更')
        } else {
          socket.send(JSON.stringify(message))
        }
      } catch (error) {
        // 单条连接异常不阻止其他设备；关闭后客户端自动重连并读取最新历史。
        // eslint-disable-next-line no-console
        console.warn('同步连接推送失败', error)
        socket.close(1011, '同步连接中断')
      }
    }
  }

  webSocketClose(socket: WebSocket): void {
    socket.close(1000, '同步连接已关闭')
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, '同步连接中断')
  }
}

/** 数据提交成功后发布通知；新连接先读取目录，因此重连不会漏掉已提交更新。 */
export const publishHistoryChange = async (env: Bindings, userId: string): Promise<void> => {
  if (!env.SYNC) {
    throw new Error('缺少多设备同步绑定')
  }
  const stub = env.SYNC.get(env.SYNC.idFromName(userId))
  const response = await stub.fetch('https://sync.internal/notify', { method: 'POST' })
  if (!response.ok) {
    throw new Error('多设备更新通知发送失败')
  }
}
