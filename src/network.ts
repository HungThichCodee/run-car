import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import type { CarState, Controls, RemoteState } from './game'

export const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
export const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined
export const configured = Boolean(url && key)
export const stunUrls = ((import.meta.env.VITE_STUN_URLS as string | undefined) || 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean)
const iceServers: RTCIceServer[] = stunUrls.length ? [{ urls: stunUrls }] : []

let client: SupabaseClient | null = null
export async function supabase() {
  if (!configured) throw new Error('Chưa cấu hình multiplayer')
  client ||= createClient(url!, key!, { auth: { persistSession: true, autoRefreshToken: true } })
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  if (!data.session) {
    const auth = await client.auth.signInAnonymously()
    if (auth.error) throw auth.error
  }
  return client
}
export function randomToken(bytes = 18) {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(data, b => b.toString(16).padStart(2, '0')).join('')
}
export type Player = { id: string, name: string, ready: boolean, host: boolean, color: number }
type Signal = { to: string, from: string, kind: 'offer' | 'answer' | 'ice', data: unknown }
type Peer = { connection: RTCPeerConnection, channel?: RTCDataChannel, pendingIce: RTCIceCandidateInit[] }
const validControls = (v: unknown): v is Controls => {
  if (!v || typeof v !== 'object') return false
  const c = v as Controls
  return typeof c.steer === 'number' && Number.isFinite(c.steer) && Math.abs(c.steer) <= 1 &&
    typeof c.throttle === 'number' && c.throttle >= 0 && c.throttle <= 1 &&
    typeof c.brake === 'number' && c.brake >= 0 && c.brake <= 1 && typeof c.handbrake === 'boolean'
}
const validCar = (v: unknown): v is CarState => {
  if (!v || typeof v !== 'object') return false
  const s = v as CarState
  return [s.x, s.y, s.z, s.yaw, s.speed, s.lap, s.t].every(Number.isFinite) &&
    Math.abs(s.x) < 200 && Math.abs(s.z) < 200 && Math.abs(s.y) < 50 && Number.isInteger(s.lap) && s.lap >= 0 && s.lap <= 3
}

export class Room {
  readonly id = randomToken(12)
  readonly color = Math.floor(Math.random() * 0xffffff)
  private channel?: RealtimeChannel
  private peers = new Map<string, Peer>()
  private lastSend = 0
  private lastSeen = new Map<string, number>()
  private retryTimer = 0
  private raceEpoch = 0
  private client?: SupabaseClient
  private gone = false
  players: Player[] = []
  onPlayers?: (players: Player[]) => void
  onStatus?: (status: string) => void
  onCar?: (car: RemoteState) => void
  onStart?: () => void
  onFinish?: (id: string, time: number) => void
  constructor(readonly code: string, readonly name: string, readonly host: boolean) {}

  async join() {
    this.client = await supabase()
    this.onStatus?.('Đang vào phòng…')
    this.channel = this.client.channel('game:room:' + this.code, { config: { private: true, presence: { key: this.id }, broadcast: { self: false } } })
    this.channel.on('presence', { event: 'sync' }, () => this.sync())
    this.channel.on('broadcast', { event: 'signal' }, ({ payload }) => this.signal(payload as Signal))
    this.channel.on('broadcast', { event: 'start' }, ({ payload }) => {
      if (payload?.host !== this.hostId() || !Number.isFinite(payload?.startAt)) return
      const startAt = Number(payload.startAt)
      if (startAt <= this.raceEpoch) return
      this.raceEpoch = startAt
      window.setTimeout(() => { if (!this.gone) this.onStart?.() }, Math.min(1600, Math.max(0, startAt - Date.now())))
    })
    this.channel.on('broadcast', { event: 'finish' }, ({ payload }) => {
      if (typeof payload?.id === 'string' && Number.isFinite(payload?.time)) this.onFinish?.(payload.id, payload.time)
    })
    await new Promise<void>((resolve, reject) => {
      let done = false
      const timer = window.setTimeout(() => { if (!done) { done = true; reject(new Error('Hết thời gian kết nối Realtime')) } }, 12000)
      this.channel!.subscribe(async status => {
        if (done) return
        if (status === 'SUBSCRIBED') {
          done = true; clearTimeout(timer)
          const result = await this.channel!.track({ id: this.id, name: this.name.slice(0, 24), ready: this.host, host: this.host, color: this.color })
          if (result !== 'ok') reject(new Error('Không thể đăng ký presence')); else resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          done = true; clearTimeout(timer); reject(new Error('Realtime bị từ chối. Kiểm tra Anonymous Sign-ins, private channel và SQL policies.'))
        }
      })
    })
    this.retryTimer = window.setInterval(() => this.checkPeers(), 4000)
    this.onStatus?.('Đã vào phòng ' + this.code)
  }
  private hostId() { return this.players.find(p => p.host)?.id }
  private sync() {
    if (!this.channel || this.gone) return
    const state = this.channel.presenceState()
    const players: Player[] = Object.values(state).flatMap(presences => presences.map(raw => {
      const p = raw as unknown as Player
      return { id: String(p.id || ''), name: String(p.name || '').slice(0, 24), ready: Boolean(p.ready), host: Boolean(p.host), color: Number(p.color) || 0xffffff }
    })).filter(p => p.id)
    players.sort((a, b) => a.id.localeCompare(b.id))
    if (players.length > 6 && players.findIndex(p => p.id === this.id) >= 6) {
      this.onStatus?.('Phòng đã đủ 6 người'); this.leave(); return
    }
    const old = new Set(this.players.map(p => p.id))
    this.players = players
    this.onPlayers?.(players)
    if (!this.host && !players.some(p => p.host)) this.onStatus?.('Host đã rời phòng. Hãy thoát và tạo phòng mới.')
    for (const p of players) {
      if (p.id === this.id) continue
      if (this.id < p.id && !this.peers.has(p.id)) this.connect(p.id)
      old.delete(p.id)
    }
    for (const id of old) if (id !== this.id) this.drop(id)
  }
  async ready(value: boolean) {
    const result = await this.channel?.track({ id: this.id, name: this.name.slice(0, 24), ready: value, host: this.host, color: this.color })
    if (result !== 'ok') throw new Error('Không cập nhật được trạng thái sẵn sàng')
  }
  async start() {
    if (!this.host || this.players.length < 1 || this.players.some(p => !p.ready)) return false
    if (!this.channel) throw new Error('Đã mất kết nối phòng')
    const startAt = Date.now() + 1600
    const result = await this.channel.send({ type: 'broadcast', event: 'start', payload: { host: this.id, startAt } })
    if (result !== 'ok') throw new Error('Không gửi được lệnh bắt đầu qua Realtime')
    this.raceEpoch = startAt
    window.setTimeout(() => { if (!this.gone) this.onStart?.() }, Math.max(0, startAt - Date.now()))
    return true
  }
  finish(time: number) { this.channel?.send({ type: 'broadcast', event: 'finish', payload: { id: this.id, time } }) }
  private peer(id: string) {
    const existing = this.peers.get(id)
    if (existing) return existing
    const connection = new RTCPeerConnection({ iceServers })
    const peer: Peer = { connection, pendingIce: [] }
    this.peers.set(id, peer)
    connection.onicecandidate = e => { if (e.candidate) this.sendSignal(id, 'ice', e.candidate.toJSON()) }
    connection.ondatachannel = e => this.bindChannel(id, e.channel)
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') this.onStatus?.('Mất kết nối P2P với ' + (this.players.find(p => p.id === id)?.name || 'người chơi') + '. Đang thử lại…')
    }
    return peer
  }
  private bindChannel(id: string, channel: RTCDataChannel) {
    const peer = this.peer(id); peer.channel = channel
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 500) return
      try {
        const value = JSON.parse(event.data)
        if (value.type !== 'car' || !validCar(value.state)) return
        const player = this.players.find(p => p.id === id)
        if (player) { this.lastSeen.set(id, Date.now()); this.onCar?.({ ...value.state, id, name: player.name, color: player.color }) }
      } catch { /* Ignore malformed peer traffic. */ }
    }
    channel.onopen = () => this.onStatus?.('P2P đã kết nối')
  }
  private async connect(id: string) {
    try {
      const peer = this.peer(id)
      const channel = peer.connection.createDataChannel('cars', { ordered: false, maxRetransmits: 0 })
      this.bindChannel(id, channel)
      const offer = await peer.connection.createOffer()
      await peer.connection.setLocalDescription(offer)
      this.sendSignal(id, 'offer', offer)
    } catch (e) { this.onStatus?.('Không tạo được P2P: ' + String(e)) }
  }
  private sendSignal(to: string, kind: Signal['kind'], data: unknown) {
    this.channel?.send({ type: 'broadcast', event: 'signal', payload: { to, from: this.id, kind, data } })
  }
  private async signal(msg: Signal) {
    if (msg?.to !== this.id || !this.players.some(p => p.id === msg.from)) return
    try {
      const peer = this.peer(msg.from)
      if (msg.kind === 'offer') {
        await peer.connection.setRemoteDescription(msg.data as RTCSessionDescriptionInit)
        for (const candidate of peer.pendingIce.splice(0)) await peer.connection.addIceCandidate(candidate)
        const answer = await peer.connection.createAnswer()
        await peer.connection.setLocalDescription(answer)
        this.sendSignal(msg.from, 'answer', answer)
      } else if (msg.kind === 'answer') {
        await peer.connection.setRemoteDescription(msg.data as RTCSessionDescriptionInit)
        for (const candidate of peer.pendingIce.splice(0)) await peer.connection.addIceCandidate(candidate)
      } else if (msg.kind === 'ice') {
        if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(msg.data as RTCIceCandidateInit)
        else peer.pendingIce.push(msg.data as RTCIceCandidateInit)
      }
    } catch (e) { this.onStatus?.('Lỗi kết nối P2P: ' + String(e)) }
  }
  sendCar(state: CarState) {
    if (performance.now() - this.lastSend < 100) return
    this.lastSend = performance.now()
    const packet = JSON.stringify({ type: 'car', state })
    for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open' && peer.channel.bufferedAmount < 16000) peer.channel.send(packet)
  }
  private checkPeers() {
    for (const p of this.players) if (p.id !== this.id && this.id < p.id) {
      const peer = this.peers.get(p.id)
      if (!peer || peer.connection.connectionState === 'failed' || peer.connection.connectionState === 'closed') { this.drop(p.id); this.connect(p.id) }
    }
  }
  private drop(id: string) { this.peers.get(id)?.connection.close(); this.peers.delete(id); this.lastSeen.delete(id) }
  async leave() {
    this.gone = true; clearInterval(this.retryTimer)
    for (const id of this.peers.keys()) this.drop(id)
    if (this.channel && this.client) await this.client.removeChannel(this.channel)
    this.channel = undefined; this.players = []; this.onPlayers?.([])
  }
}

export class Pairing {
  private client?: SupabaseClient
  private channel?: RealtimeChannel
  private peer?: RTCPeerConnection
  private data?: RTCDataChannel
  private token?: string
  private timer = 0
  private consumed = false
  private pendingIce: RTCIceCandidateInit[] = []
  private connectTimeout = 0
  private controlTimer = 0
  private lastControl = 0
  private controlLost = false
  onStatus?: (text: string) => void
  onControls?: (controls: Controls | null) => void
  onConnected?: () => void
  async host() {
    await this.close()
    this.client = await supabase()
    this.token = randomToken(24); this.consumed = false
    await this.subscribe()
    this.timer = window.setTimeout(() => { this.onStatus?.('QR đã hết hạn'); this.close() }, 120000)
    const link = new URL(window.location.href)
    link.search = ''; link.searchParams.set('controller', this.token)
    link.hash = ''
    return link.toString()
  }
  async phone(token: string) {
    if (!/^[0-9a-f]{48}$/.test(token)) throw new Error('Mã ghép nối không hợp lệ')
    this.token = token; this.client = await supabase(); await this.subscribe()
    await this.channel!.send({ type: 'broadcast', event: 'hello', payload: { token } })
    this.onStatus?.('Đang chờ máy tính xác nhận…')
    this.connectTimeout = window.setTimeout(() => {
      if (this.data?.readyState !== 'open') this.onStatus?.('Không thấy máy tính hoặc kết nối bị chặn. Quét QR mới và thử lại.')
    }, 25000)
  }
  private async subscribe() {
    this.channel = this.client!.channel('game:pair:' + this.token, { config: { private: true, broadcast: { self: false } } })
    this.channel.on('broadcast', { event: 'hello' }, async ({ payload }) => {
      if (!this.timer || this.consumed || payload?.token !== this.token) return
      this.consumed = true; clearTimeout(this.timer)
      this.peer = new RTCPeerConnection({ iceServers })
      this.peer.onicecandidate = e => { if (e.candidate) this.send('ice', e.candidate.toJSON()) }
      this.data = this.peer.createDataChannel('wheel', { ordered: false, maxRetransmits: 0 })
      this.bindData(this.data)
      this.watchConnection()
      const offer = await this.peer.createOffer(); await this.peer.setLocalDescription(offer); this.send('offer', offer)
    })
    this.channel.on('broadcast', { event: 'signal' }, async ({ payload }) => {
      try {
        if (payload?.kind === 'offer' && !this.timer) {
          this.peer = new RTCPeerConnection({ iceServers })
          this.peer.onicecandidate = e => { if (e.candidate) this.send('ice', e.candidate.toJSON()) }
          this.peer.ondatachannel = e => { this.data = e.channel; this.bindData(e.channel) }
          await this.peer.setRemoteDescription(payload.data)
          for (const candidate of this.pendingIce.splice(0)) await this.peer.addIceCandidate(candidate)
          this.watchConnection()
          const answer = await this.peer.createAnswer(); await this.peer.setLocalDescription(answer); this.send('answer', answer)
        } else if (payload?.kind === 'answer' && this.timer && this.peer) {
          await this.peer.setRemoteDescription(payload.data)
          for (const candidate of this.pendingIce.splice(0)) await this.peer.addIceCandidate(candidate)
        } else if (payload?.kind === 'ice') {
          if (this.peer?.remoteDescription) await this.peer.addIceCandidate(payload.data)
          else this.pendingIce.push(payload.data)
        }
      } catch (e) { this.onStatus?.('Ghép nối thất bại: ' + String(e)) }
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Hết thời gian kết nối Realtime')), 12000)
      this.channel!.subscribe(status => {
        if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve() }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timeout); reject(new Error('Realtime bị từ chối')) }
      })
    })
  }
  private send(kind: string, data: unknown) { this.channel?.send({ type: 'broadcast', event: 'signal', payload: { kind, data } }) }
  private watchConnection() {
    clearTimeout(this.connectTimeout)
    this.connectTimeout = window.setTimeout(() => {
      if (this.data?.readyState !== 'open') this.onStatus?.('Ghép nối P2P quá lâu. Hãy thử lại hoặc dùng bàn phím/nút cảm ứng.')
    }, 20000)
  }
  private bindData(data: RTCDataChannel) {
    data.onopen = () => {
      clearTimeout(this.connectTimeout); this.lastControl = Date.now()
      this.controlLost = false
      clearInterval(this.controlTimer)
      this.controlTimer = window.setInterval(() => {
        if (!this.controlLost && Date.now() - this.lastControl > 900) {
          this.controlLost = true
          this.onControls?.(null)
          this.onStatus?.('Không nhận điều khiển từ điện thoại. Đang chờ kết nối lại…')
        }
      }, 300)
      this.onStatus?.('Điện thoại đã kết nối'); this.onConnected?.()
    }
    data.onclose = () => { clearInterval(this.controlTimer); this.onStatus?.('Mất kết nối điện thoại. Dùng bàn phím hoặc nút cảm ứng.'); this.onControls?.(null) }
    data.onmessage = e => {
      if (typeof e.data !== 'string' || e.data.length > 200) return
      try {
        const v = JSON.parse(e.data)
        if (validControls(v)) {
          this.lastControl = Date.now()
          if (this.controlLost) { this.controlLost = false; this.onStatus?.('Điện thoại đã kết nối lại') }
          this.onControls?.(v)
        }
      } catch { /* Ignore malformed controls. */ }
    }
    this.peer!.onconnectionstatechange = () => {
      if (this.peer?.connectionState === 'failed') { this.onStatus?.('P2P thất bại. Thử lại hoặc dùng bàn phím/nút cảm ứng.'); this.onControls?.(null) }
    }
  }
  sendControls(value: Controls) { if (this.data?.readyState === 'open' && validControls(value)) this.data.send(JSON.stringify(value)) }
  async close() {
    clearTimeout(this.timer); clearTimeout(this.connectTimeout); clearInterval(this.controlTimer); this.timer = 0
    this.pendingIce = []
    this.data?.close(); this.peer?.close(); this.peer = undefined
    if (this.channel && this.client) await this.client.removeChannel(this.channel)
    this.channel = undefined; this.onControls?.(null)
  }
}
