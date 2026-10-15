import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { buildTrack, point, progress, tangentAngle, ROAD_HALF_WIDTH, RX, RZ } from './track'

export type Controls = { steer: number, throttle: number, brake: number, handbrake: boolean }
export type CarState = { x: number, y: number, z: number, yaw: number, speed: number, lap: number, t: number }
export type RemoteState = CarState & { id: string, name: string, color: number }
type RemoteCar = { mesh: THREE.Group, state: RemoteState, stamp: number }

function carModel(color: number) {
  const car = new THREE.Group()
  const paint = new THREE.MeshStandardMaterial({ color, metalness: .42, roughness: .31 })
  const shell = new THREE.Mesh(new THREE.BoxGeometry(1.8, .55, 3.45), paint)
  shell.position.y = .55; shell.castShadow = true; car.add(shell)
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.38, .6, 1.65), new THREE.MeshStandardMaterial({ color: 0x172e42, metalness: .25, roughness: .2 }))
  cabin.position.set(0, 1.05, -.1); cabin.castShadow = true; car.add(cabin)
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff3d2, emissive: 0xffe4a0, emissiveIntensity: .5 })
  for (const x of [-.63, .63]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(.36, .18, .08), lightMat)
    light.position.set(x, .61, 1.76); car.add(light)
  }
  const wheels: THREE.Mesh[] = []
  const wheelGeo = new THREE.CylinderGeometry(.38, .38, .25, 12)
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x101417, roughness: 1 })
  for (const z of [-1.15, 1.15]) for (const x of [-.98, .98]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat)
    wheel.rotation.z = Math.PI / 2; wheel.position.set(x, 0, z); wheel.castShadow = true
    wheels.push(wheel); car.add(wheel)
  }
  return { car, wheels }
}

export class Game {
  private scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private camera = new THREE.PerspectiveCamera(66, 1, .1, 350)
  private world!: RAPIER.World
  private body!: RAPIER.RigidBody
  private model!: ReturnType<typeof carModel>
  private track!: ReturnType<typeof buildTrack>
  private remotes = new Map<string, RemoteCar>()
  private clock = new THREE.Clock()
  private frame = 0
  private raf = 0
  private disposed = false
  private onResize = () => this.resize()
  private onKeyDown = (event: KeyboardEvent) => { this.keys.add(event.code); if (event.code === 'KeyR') this.reset() }
  private onKeyUp = (event: KeyboardEvent) => this.keys.delete(event.code)
  private keys = new Set<string>()
  private touch: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: false }
  private phone: Controls | null = null
  private lastLapAngle = 0
  private checkpoint = 0
  private lastProgress = 0
  private laps = 0
  private startedAt = 0
  private raceStarted = false
  private finished = false
  private status = 'Đang tải vật lý…'
  private slow = false
  private slippery = false
  private speed = 0
  onUpdate?: (state: CarState, hud: { speed: number, laps: number, checkpoint: number, time: number, status: string, finished: boolean }) => void

  constructor(private mount: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(this.renderer.domElement)
  }
  async init() {
    try {
      await RAPIER.init()
      if (this.disposed) return
      this.world = new RAPIER.World({ x: 0, y: -18, z: 0 })
      this.scene.background = new THREE.Color(0x89bce2)
      this.scene.fog = new THREE.Fog(0x89bce2, 75, 200)
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x456252, 2.2))
      const sun = new THREE.DirectionalLight(0xfff2d4, 2.4)
      sun.position.set(-30, 65, 25); sun.castShadow = true
      sun.shadow.mapSize.set(1024, 1024)
      sun.shadow.camera.left = -90; sun.shadow.camera.right = 90
      sun.shadow.camera.top = 90; sun.shadow.camera.bottom = -90
      this.scene.add(sun)
      this.track = buildTrack(this.scene, this.world)
      this.model = carModel(0x36d8ca); this.scene.add(this.model.car)
      this.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(RX, .85, -2).setLinearDamping(.13).setAngularDamping(2).setCcdEnabled(true))
      this.body.setEnabledRotations(false, true, false, true)
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(.85, .7, 1.55).setTranslation(0, .3, 0).setFriction(1.25).setRestitution(.12).setDensity(1.5), this.body)
      this.reset()
      window.addEventListener('resize', this.onResize)
      window.addEventListener('keydown', this.onKeyDown)
      window.addEventListener('keyup', this.onKeyUp)
      this.resize()
      this.status = 'Sẵn sàng'
      this.clock.start()
      this.loop()
    } catch (error) {
      this.status = 'Không tải được Rapier WebAssembly: ' + String(error)
      throw error
    }
  }
  private resize() {
    const w = this.mount.clientWidth, h = this.mount.clientHeight
    if (!w || !h) return
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h)
  }
  setTouch(control: Partial<Controls>) { this.touch = { ...this.touch, ...control } }
  setPhone(control: Controls | null) { this.phone = control }
  startRace() { this.laps = 0; this.checkpoint = 0; this.lastLapAngle = 0; this.lastProgress = 0; this.finished = false; this.startedAt = performance.now(); this.raceStarted = true; this.reset() }
  reset() {
    if (!this.body) return
    const p = point(this.lastLapAngle, 0)
    const yaw = tangentAngle(this.lastLapAngle)
    this.body.setTranslation({ x: p.x, y: .85, z: p.z }, true)
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }
  private controls(): Controls {
    const key = (s: string) => this.keys.has(s)
    const keyboard = { steer: Number(key('KeyD') || key('ArrowRight')) - Number(key('KeyA') || key('ArrowLeft')), throttle: Number(key('KeyW') || key('ArrowUp')), brake: Number(key('KeyS') || key('ArrowDown')), handbrake: key('Space') }
    const p = this.phone || this.touch
    return { steer: Math.abs(keyboard.steer) > 0 ? keyboard.steer : p.steer, throttle: Math.max(keyboard.throttle, p.throttle), brake: Math.max(keyboard.brake, p.brake), handbrake: keyboard.handbrake || p.handbrake }
  }
  private physics(dt: number) {
    const pos = this.body.translation(), vel = this.body.linvel(), rot = this.body.rotation()
    const yaw = 2 * Math.atan2(rot.y, rot.w)
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    const side = new THREE.Vector3(forward.z, 0, -forward.x)
    const v = new THREE.Vector3(vel.x, 0, vel.z)
    const forwardSpeed = v.dot(forward), lateral = v.dot(side)
    this.speed = Math.abs(forwardSpeed)
    const c = this.controls()
    const angle = progress(pos.x, pos.z)
    const center = point(angle)
    const dist = Math.hypot(pos.x - center.x, pos.z - center.z)
    this.slow = angle > 1.07 && angle < 1.33 && dist < 3.5
    this.slippery = angle > 4.16 && angle < 4.44 && dist < 3.5
    const grip = this.slippery ? .35 : c.handbrake ? .24 : 1
    const mass = this.body.mass()
    // Four downward raycasts keep the visible wheels aligned to the surface.
    const wheelOffsets = [[-.98, -1.15], [.98, -1.15], [-.98, 1.15], [.98, 1.15]]
    let grounded = 0
    for (let i = 0; i < 4; i++) {
      const [wx, wz] = wheelOffsets[i]
      const px = pos.x + side.x * wx + forward.x * wz
      const pz = pos.z + side.z * wx + forward.z * wz
      const ray = new RAPIER.Ray({ x: px, y: pos.y + .5, z: pz }, { x: 0, y: -1, z: 0 })
      const hit = this.world.castRay(ray, 1.6, true, undefined, undefined, undefined, this.body)
      if (hit) {
        grounded++
        // A short spring impulse at each raycast wheel supports the chassis.
        const spring = Math.max(0, (1.1 - hit.timeOfImpact) * 95 - vel.y * 8)
        this.body.applyImpulseAtPoint({ x: 0, y: spring * this.body.mass() * dt / 4, z: 0 }, { x: px, y: pos.y, z: pz }, true)
      }
      this.model.wheels[i].position.y = hit ? THREE.MathUtils.clamp(pos.y + .5 - hit.timeOfImpact + .38 - pos.y, -.4, .3) : 0
      this.model.wheels[i].rotation.x -= forwardSpeed * dt / .38
    }
    if (grounded) {
      const engine = c.throttle * (this.slow ? 35 : 64)
      const braking = c.brake * Math.sign(forwardSpeed) * 95
      const drag = forwardSpeed * Math.abs(forwardSpeed) * .12
      this.body.applyImpulse({ x: forward.x * (engine - braking - drag) * mass * dt, y: 0, z: forward.z * (engine - braking - drag) * mass * dt }, true)
      this.body.applyImpulse({ x: -side.x * lateral * mass * Math.min(1, grip * 9 * dt), y: 0, z: -side.z * lateral * mass * Math.min(1, grip * 9 * dt) }, true)
      const steerRate = c.steer * Math.min(1, this.speed / 5) * (c.handbrake ? 1.8 : 1.25) * (forwardSpeed < -1 ? -1 : 1)
      this.body.setAngvel({ x: 0, y: steerRate, z: 0 }, true)
    }
    if (pos.y < -3 || Math.abs(pos.x) > 105 || Math.abs(pos.z) > 85) this.reset()
    if (dist > ROAD_HALF_WIDTH + 6 && this.speed < 1.5) this.status = 'Ra khỏi đường — nhấn R để trở lại'
    else this.status = this.slippery ? 'Đường trơn' : this.slow ? 'Vùng giảm tốc' : 'Đang đua'
    if (this.raceStarted && !this.finished && dist < ROAD_HALF_WIDTH + 1) {
      const quarter = Math.floor(angle / (Math.PI / 2))
      if (this.checkpoint === 3 && this.lastProgress > 5.5 && angle < .5 && forwardSpeed > 0) {
        this.laps++; this.checkpoint = 0
        if (this.laps >= 3) { this.finished = true; this.status = 'Về đích!' }
      }
      else if (quarter === (this.checkpoint + 1) % 4 && angle > this.lastProgress - .3) this.checkpoint = quarter
    }
    this.lastProgress = angle
    if (dist < ROAD_HALF_WIDTH) this.lastLapAngle = angle
  }
  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), .04)
    if (this.body) {
      this.physics(dt)
      this.track.update(this.clock.elapsedTime)
      this.world.timestep = 1 / 60
      this.world.step()
      const p = this.body.translation(), q = this.body.rotation()
      this.model.car.position.set(p.x, p.y, p.z)
      this.model.car.quaternion.set(q.x, q.y, q.z, q.w)
      const yaw = 2 * Math.atan2(q.y, q.w)
      const desired = new THREE.Vector3(p.x - Math.sin(yaw) * 10, p.y + 6, p.z - Math.cos(yaw) * 10)
      this.camera.position.lerp(desired, Math.min(1, dt * 4))
      this.camera.lookAt(p.x, p.y + 1, p.z)
      const now = performance.now()
      for (const [id, remote] of this.remotes) {
        if (now - remote.stamp > 12000) { this.scene.remove(remote.mesh); this.remotes.delete(id); continue }
        remote.mesh.position.lerp(new THREE.Vector3(remote.state.x, remote.state.y, remote.state.z), .18)
        remote.mesh.rotation.y += (THREE.MathUtils.euclideanModulo(remote.state.yaw - remote.mesh.rotation.y + Math.PI, Math.PI * 2) - Math.PI) * .18
      }
      if (++this.frame % 3 === 0) this.onUpdate?.({ x: p.x, y: p.y, z: p.z, yaw, speed: this.speed, lap: this.laps, t: now }, { speed: this.speed * 3.6, laps: this.laps, checkpoint: this.checkpoint, time: this.raceStarted ? (now - this.startedAt) / 1000 : 0, status: this.status, finished: this.finished })
    }
    this.renderer.render(this.scene, this.camera)
  }
  setRemote(state: RemoteState) {
    if (![state.x, state.y, state.z, state.yaw, state.speed, state.lap, state.t].every(Number.isFinite)) return
    if (Math.abs(state.x) > 200 || Math.abs(state.z) > 200) return
    let remote = this.remotes.get(state.id)
    if (!remote) {
      const model = carModel(state.color)
      this.scene.add(model.car)
      remote = { mesh: model.car, state, stamp: performance.now() }
      remote.mesh.position.set(state.x, state.y, state.z)
      this.remotes.set(state.id, remote)
    }
    if (state.t < remote.state.t) return
    remote.state = state; remote.stamp = performance.now()
  }
  removeRemote(id: string) { const remote = this.remotes.get(id); if (remote) { this.scene.remove(remote.mesh); this.remotes.delete(id) } }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.onResize); window.removeEventListener('keydown', this.onKeyDown); window.removeEventListener('keyup', this.onKeyUp)
    this.scene.traverse(object => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose(); if (mesh.material) for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mat.dispose() })
    this.renderer.dispose(); this.renderer.domElement.remove()
    this.world?.free()
  }
}
