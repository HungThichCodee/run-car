import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

export const RX = 32
export const RZ = 20
export const ROAD_HALF_WIDTH = 6
const COUNT = 128

export function point(t: number, offset = 0): THREE.Vector3 {
  const x = RX * Math.cos(t), z = RZ * Math.sin(t)
  const tangent = new THREE.Vector3(-RX * Math.sin(t), 0, RZ * Math.cos(t)).normalize()
  return new THREE.Vector3(x + tangent.z * offset, 0, z - tangent.x * offset)
}

export function tangentAngle(t: number) {
  const a = new THREE.Vector3(-RX * Math.sin(t), 0, RZ * Math.cos(t)).normalize()
  return Math.atan2(a.x, a.z)
}

export function progress(x: number, z: number) {
  const a = Math.atan2(z / RZ, x / RX)
  return (a + Math.PI * 2) % (Math.PI * 2)
}

export function buildTrack(scene: THREE.Scene, world: RAPIER.World) {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 180), new THREE.MeshStandardMaterial({ color: 0x386a43, roughness: 1 }))
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)
  world.createCollider(RAPIER.ColliderDesc.cuboid(110, .1, 90).setTranslation(0, -.12, 0).setFriction(1.1))

  const verts: number[] = [], indices: number[] = []
  for (let i = 0; i <= COUNT; i++) {
    const t = i / COUNT * Math.PI * 2
    for (const offset of [-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH]) {
      const p = point(t, offset)
      verts.push(p.x, .025, p.z)
    }
    if (i < COUNT) {
      const j = i * 2
      indices.push(j, j + 2, j + 1, j + 1, j + 2, j + 3)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const road = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x27313a, side: THREE.DoubleSide, roughness: .92 }))
  road.receiveShadow = true
  scene.add(road)

  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf9eabe })
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe9f1ec })
  const barrierMat = new THREE.MeshStandardMaterial({ color: 0xf66d53, metalness: .1 })
  for (let i = 0; i < COUNT; i++) {
    const t = (i + .5) / COUNT * Math.PI * 2
    const heading = tangentAngle(t)
    if (i % 3 !== 0) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(.14, .025, 1.5), stripeMat)
      stripe.position.copy(point(t)); stripe.position.y = .055; stripe.rotation.y = heading
      scene.add(stripe)
    }
    for (const side of [-1, 1]) {
      const p = point(t, side * (ROAD_HALF_WIDTH - .18))
      const edge = new THREE.Mesh(new THREE.BoxGeometry(.15, .03, .9), edgeMat)
      edge.position.set(p.x, .06, p.z); edge.rotation.y = heading
      scene.add(edge)
      if (i % 2 === 0) {
        const b = point(t, side * (ROAD_HALF_WIDTH + .6))
        const rail = new THREE.Mesh(new THREE.BoxGeometry(.3, .7, 2.4), barrierMat)
        rail.position.set(b.x, .45, b.z); rail.rotation.y = heading
        rail.castShadow = true; scene.add(rail)
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.x, .45, b.z).setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }))
        world.createCollider(RAPIER.ColliderDesc.cuboid(.15, .35, 1.2).setRestitution(.2), body)
      }
    }
  }
  // Start line and four checkpoints.
  for (let c = 0; c < 4; c++) {
    const t = c * Math.PI / 2
    for (let j = -6; j < 6; j++) {
      const p = point(t, j + .5)
      const mark = new THREE.Mesh(new THREE.BoxGeometry(1, .03, .85), new THREE.MeshStandardMaterial({ color: c === 0 && j % 2 === 0 ? 0x15191d : 0xffffff }))
      mark.position.set(p.x, .065, p.z); mark.rotation.y = tangentAngle(t)
      if (c === 0) scene.add(mark)
    }
  }
  const boxGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2)
  const coneGeo = new THREE.ConeGeometry(.48, 1.2, 8)
  const dynamic: { mesh: THREE.Mesh, body: RAPIER.RigidBody }[] = []
  for (let k = 0; k < 14; k++) {
    const t = .35 + k * .42
    const offset = k % 3 === 0 ? -2.4 : k % 3 === 1 ? 2.4 : .2
    const p = point(t, offset)
    const cone = k % 2 === 0
    const mesh = new THREE.Mesh(cone ? coneGeo : boxGeo, new THREE.MeshStandardMaterial({ color: cone ? 0xff9e36 : 0xc87552, roughness: .8 }))
    mesh.position.set(p.x, .7, p.z); mesh.castShadow = true
    scene.add(mesh)
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, .7, p.z).setLinearDamping(.7))
    world.createCollider(cone ? RAPIER.ColliderDesc.cone(.6, .48).setDensity(.4) : RAPIER.ColliderDesc.cuboid(.6, .6, .6).setDensity(.8), body)
    dynamic.push({ mesh, body })
  }
  // A slow moving obstacle crosses the road.
  const moving = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.3, 1.8), new THREE.MeshStandardMaterial({ color: 0xf7c95a }))
  moving.castShadow = true; scene.add(moving)
  const movingBody = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(point(2.2).x, .72, point(2.2).z))
  world.createCollider(RAPIER.ColliderDesc.cuboid(.9, .65, .9), movingBody)
  // Large obvious slow and slippery zones.
  for (const [t, color] of [[1.2, 0xb56e38], [4.3, 0x9bcee7]] as const) {
    const p = point(t)
    const zone = new THREE.Mesh(new THREE.CircleGeometry(3.4, 32), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: .65 }))
    zone.rotation.x = -Math.PI / 2; zone.position.set(p.x, .045, p.z); scene.add(zone)
  }
  const sceneryMat = new THREE.MeshStandardMaterial({ color: 0x214a31 })
  for (let i = 0; i < 44; i++) {
    const t = i * 2.399
    const r = i % 2 ? 60 : 12
    const x = Math.cos(t) * (r + i % 7), z = Math.sin(t) * (r * .72 + i % 5)
    if (Math.abs(x) < 23 && Math.abs(z) < 12 && i % 2) continue
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.17, .25, 2, 6), new THREE.MeshStandardMaterial({ color: 0x6c4b32 }))
    trunk.position.set(x, 1, z); scene.add(trunk)
    const crown = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4, 7), sceneryMat)
    crown.position.set(x, 3.6, z); crown.castShadow = true; scene.add(crown)
  }
  return {
    update(time: number) {
      const p = point(2.2, Math.sin(time * .8) * 3)
      movingBody.setNextKinematicTranslation({ x: p.x, y: .72, z: p.z })
      moving.position.set(p.x, .72, p.z)
      for (const item of dynamic) {
        const p = item.body.translation(), q = item.body.rotation()
        item.mesh.position.set(p.x, p.y, p.z); item.mesh.quaternion.set(q.x, q.y, q.z, q.w)
      }
    }
  }
}
