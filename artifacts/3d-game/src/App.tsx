import { useCallback, useEffect, useRef, useState } from 'react';

type GameStatus = 'loading' | 'ready' | 'over' | 'error';
type Runtime = {
  dispose: () => void;
  restart: () => void;
  drop: () => void;
  setPaused: (paused: boolean) => void;
};
type BlockPlan = {
  shape: 'box' | 'cylinder';
  color: number;
  dimensions: [number, number, number];
};

const importFromCdn = new Function(
  'url',
  'return import(url)',
) as (url: string) => Promise<any>;

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js';
const CANNON_URL = 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
const BLOCK_COLORS = [0x75e3c0, 0xf28ab0, 0xf0c46b, 0x79c8dc, 0xb89ae9, 0xff9678];

function makeBlockPlan(): BlockPlan {
  const color = BLOCK_COLORS[Math.floor(Math.random() * BLOCK_COLORS.length)];
  if (Math.random() < 0.27) {
    const radius = 0.68 + Math.random() * 0.12;
    const height = 0.8 + Math.random() * 0.48;
    return { shape: 'cylinder', color, dimensions: [radius * 2, height, radius * 2] };
  }
  const width = 1.25 + Math.random() * 0.42;
  const height = 0.72 + Math.random() * 0.5;
  const depth = 1.2 + Math.random() * 0.42;
  return { shape: 'box', color, dimensions: [width, height, depth] };
}

function colorToCss(color: number) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function StackerMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 16.5h15M7 12h10M9.5 7.5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 3.5v2M12 18.5v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16.2 8A6.5 6.5 0 0 0 4.7 5.6L3 7.2M3 4.4v2.9h2.9M3.8 12a6.5 6.5 0 0 0 11.5 2.4l1.7-1.6m0 2.8v-2.9h-2.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 3v10m0 0 4-4m-4 4L6 9M4 16.5h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const statusRef = useRef<GameStatus>('loading');
  const [status, setStatus] = useState<GameStatus>('loading');
  const [score, setScore] = useState(0);
  const [height, setHeight] = useState(0);
  const [bestHeight, setBestHeight] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('stacker-best-height'));
      return Number.isFinite(saved) ? saved : 0;
    } catch {
      return 0;
    }
  });
  const [nextBlock, setNextBlock] = useState<BlockPlan>(makeBlockPlan);
  const [dropOffset, setDropOffset] = useState(0);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const nextBlockRef = useRef(nextBlock);
  const controlsRef = useRef({ x: 0, rotation: 0 });
  const [retry, setRetry] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  nextBlockRef.current = nextBlock;

  const updateStatus = useCallback((next: GameStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    if (height <= bestHeight) return;
    setBestHeight(height);
    try {
      window.localStorage.setItem('stacker-best-height', String(height));
    } catch {
      // Keep the current session usable when browser storage is unavailable.
    }
  }, [bestHeight, height]);

  const moveDropPosition = (direction: number) => {
    const nextX = Math.max(-1, Math.min(1, controlsRef.current.x + direction * 0.25));
    controlsRef.current.x = nextX;
    setDropOffset(nextX);
  };

  const rotateNextBlock = () => {
    controlsRef.current.rotation = (controlsRef.current.rotation + Math.PI / 12) % (Math.PI * 2);
    setPreviewRotation(controlsRef.current.rotation);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const fallbackCanvas = fallbackCanvasRef.current;
    if (!canvas || !fallbackCanvas) return;

    let disposed = false;
    let rafId = 0;
    let resizeObserver: ResizeObserver | undefined;
    let resizeHandler: (() => void) | undefined;
    let renderer: any;
    let scene: any;
    let camera: any;
    let world: any;
    let THREE: any;
    let CANNON: any;
    let platformMesh: any;
    let grid: any;
    let sharedBlockMaterial: any;
    let animationTime = 0;
    let frameCount = 0;
    let lastFrameTime = 0;
    let cameraTargetY = 0.65;
    let gameOver = false;
    let paused = false;
    let usingFallback = false;
    let renderCanvas = canvas;
    let fallbackContext: CanvasRenderingContext2D | null = null;
    let drawFallback = () => {};

    type Piece = {
      body: any;
      mesh: any;
      kind: 'box' | 'cylinder';
      born: number;
      stillFor: number;
      counted: boolean;
      color: number;
    };
    let pieces: Piece[] = [];

    updateStatus('loading');
    setErrorMessage('');

    const clearPieces = () => {
      if (!world || !scene) return;
      for (const piece of pieces) {
        world.removeBody(piece.body);
        scene.remove(piece.mesh);
        piece.mesh.geometry?.dispose();
        if (Array.isArray(piece.mesh.material)) {
          piece.mesh.material.forEach((material: any) => material.dispose());
        } else {
          piece.mesh.material?.dispose();
        }
      }
      pieces = [];
    };

    const buildWorld = () => {
      clearPieces();
      if (platformMesh) {
        scene.remove(platformMesh);
        platformMesh.traverse((object: any) => {
          object.geometry?.dispose();
          if (Array.isArray(object.material)) object.material.forEach((material: any) => material.dispose());
          else object.material?.dispose();
        });
      }
      world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
      world.allowSleep = true;
      world.broadphase = new CANNON.SAPBroadphase(world);
      world.solver.iterations = 12;
      world.solver.tolerance = 0.001;

      const floorMaterial = new CANNON.Material('platform');
      sharedBlockMaterial = new CANNON.Material('blocks');
      world.addContactMaterial(new CANNON.ContactMaterial(floorMaterial, sharedBlockMaterial, {
        friction: 0.58,
        restitution: 0.12,
      }));
      world.addContactMaterial(new CANNON.ContactMaterial(sharedBlockMaterial, sharedBlockMaterial, {
        friction: 0.62,
        restitution: 0.08,
      }));

      const platformShape = new CANNON.Box(new CANNON.Vec3(1.9, 0.28, 1.9));
      const platformBody = new CANNON.Body({ mass: 0, material: floorMaterial });
      platformBody.addShape(platformShape);
      platformBody.position.set(0, 0, 0);
      world.addBody(platformBody);

      platformMesh = new THREE.Group();
      const platformGeometry = new THREE.BoxGeometry(3.8, 0.56, 3.8);
      const platformMaterial = new THREE.MeshStandardMaterial({
        color: 0x435b63,
        roughness: 0.34,
        metalness: 0.32,
      });
      const slab = new THREE.Mesh(platformGeometry, platformMaterial);
      slab.position.y = 0;
      slab.castShadow = true;
      slab.receiveShadow = true;
      platformMesh.add(slab);

      const edgeGeometry = new THREE.BoxGeometry(3.88, 0.045, 3.88);
      const edgeMaterial = new THREE.MeshStandardMaterial({
        color: 0x79e9c4,
        emissive: 0x1b735b,
        emissiveIntensity: 0.42,
        roughness: 0.25,
        metalness: 0.45,
      });
      const edge = new THREE.Mesh(edgeGeometry, edgeMaterial);
      edge.position.y = 0.18;
      platformMesh.add(edge);
      scene.add(platformMesh);

      if (grid) {
        scene.remove(grid);
        grid.geometry?.dispose();
        const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
        materials.forEach((material: any) => material.dispose());
      }
      grid = new THREE.GridHelper(80, 40, 0x3c535d, 0x28363f);
      grid.position.y = -0.3;
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      gridMaterials.forEach((material: any) => {
        material.transparent = true;
        material.opacity = 0.4;
      });
      scene.add(grid);
    };

    const restartGame = () => {
      if (!world || !THREE || disposed) return;
      gameOver = false;
      paused = false;
      controlsRef.current = { x: 0, rotation: 0 };
      setDropOffset(0);
      setPreviewRotation(0);
      setIsPaused(false);
      const firstBlock = makeBlockPlan();
      nextBlockRef.current = firstBlock;
      setNextBlock(firstBlock);
      buildWorld();
      cameraTargetY = 0.65;
      setScore(0);
      setHeight(0);
      updateStatus('ready');
    };

    const dropPiece = () => {
      if (!world || !THREE || disposed || gameOver || paused || statusRef.current !== 'ready') return;
      if (pieces.some((piece) => !piece.counted)) return;
      const plan = nextBlockRef.current;
      const color = plan.color;
      const material = sharedBlockMaterial;
      const meshMaterial = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.27,
        metalness: 0.18,
        emissive: color,
        emissiveIntensity: 0.055,
      });
      let geometry: any;
      let shape: any;
      let mass = 1.8;
      const dims = plan.dimensions;

      if (plan.shape === 'cylinder') {
        const radius = dims[0] / 2;
        geometry = new THREE.CylinderGeometry(radius, radius, dims[1], 10, 1);
        shape = new CANNON.Cylinder(radius, radius, dims[1], 10);
        mass = 1.9;
      } else {
        geometry = new THREE.BoxGeometry(...dims);
        shape = new CANNON.Box(new CANNON.Vec3(dims[0] / 2, dims[1] / 2, dims[2] / 2));
      }

      const mesh = new THREE.Mesh(geometry, meshMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      const body = new CANNON.Body({
        mass,
        material,
        shape,
        linearDamping: 0.12,
        angularDamping: 0.2,
        allowSleep: true,
        sleepSpeedLimit: 0.12,
        sleepTimeLimit: 0.55,
      });
      body.addShape(shape);
      body.position.set(controlsRef.current.x, Math.max(2.9, cameraTargetY * 2 + 2.7), (Math.random() - 0.5) * 0.18);
      body.quaternion.setFromEuler(
        (Math.random() - 0.5) * 0.08,
        controlsRef.current.rotation,
        (Math.random() - 0.5) * 0.08,
      );
      body.velocity.set((Math.random() - 0.5) * 0.2, 0, (Math.random() - 0.5) * 0.2);
      body.angularVelocity.set((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.25);
      body.userData = { dims };
      world.addBody(body);
      pieces.push({ body, mesh, kind: plan.shape, born: animationTime, stillFor: 0, counted: false, color });
      const following = makeBlockPlan();
      nextBlockRef.current = following;
      setNextBlock(following);
      controlsRef.current = { x: 0, rotation: 0 };
      setDropOffset(0);
      setPreviewRotation(0);
    };

    const gameShell = canvas.closest('.game-shell');
    const handleCanvasClick = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, input, textarea, select, a, [role="button"]')) return;
      dropPiece();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, input, textarea, select, a, [role="button"]')) return;
      if (event.code === 'Space') {
        if (event.repeat) return;
        event.preventDefault();
        dropPiece();
        return;
      }
      if (statusRef.current !== 'ready' || paused) return;
      if (event.code === 'ArrowLeft' || event.code === 'KeyA') {
        event.preventDefault();
        moveDropPosition(-1);
      } else if (event.code === 'ArrowRight' || event.code === 'KeyD') {
        event.preventDefault();
        moveDropPosition(1);
      } else if (event.code === 'ArrowUp' || event.code === 'KeyR') {
        event.preventDefault();
        rotateNextBlock();
      }
    };

    gameShell?.addEventListener('pointerdown', handleCanvasClick);
    window.addEventListener('keydown', handleKeyDown);

    const start = async () => {
      try {
        const [threeModule, cannonModule] = await Promise.all([
          importFromCdn(THREE_URL),
          importFromCdn(CANNON_URL),
        ]);
        if (disposed) return;
        THREE = threeModule;
        CANNON = cannonModule;

        try {
          renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance',
          });
        } catch {
          // Some embedded previews disable WebGL. Keep Cannon physics running
          // and draw the same 3D bodies through a projected canvas fallback.
          usingFallback = true;
          renderCanvas = fallbackCanvas;
          canvas.style.display = 'none';
          fallbackCanvas.style.display = 'block';
          fallbackContext = fallbackCanvas.getContext('2d');
          if (!fallbackContext) throw new Error('Neither WebGL nor a 2D canvas is available.');
          renderer = {
            setPixelRatio: () => {},
            setSize: (width: number, height: number) => {
              fallbackCanvas.width = Math.max(1, Math.floor(width));
              fallbackCanvas.height = Math.max(1, Math.floor(height));
            },
            render: () => drawFallback(),
            dispose: () => {},
            forceContextLoss: () => {},
          };
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(renderCanvas.clientWidth || window.innerWidth, renderCanvas.clientHeight || window.innerHeight, false);
        if (!usingFallback) {
          renderer.shadowMap.enabled = true;
          renderer.shadowMap.type = THREE.PCFSoftShadowMap;
          renderer.outputColorSpace = THREE.SRGBColorSpace;
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.22;
        }

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x151b24);
        scene.fog = new THREE.FogExp2(0x151b24, 0.019);
        camera = new THREE.PerspectiveCamera(36, 1, 0.1, 180);
        camera.position.set(7.6, 7.2, 9.6);
        camera.lookAt(0, 0.5, 0);

        const hemi = new THREE.HemisphereLight(0xc7f2e7, 0x252b38, 2.15);
        scene.add(hemi);
        const key = new THREE.DirectionalLight(0xffe5c5, 4.2);
        key.position.set(-5, 10, 6);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.left = -8;
        key.shadow.camera.right = 8;
        key.shadow.camera.top = 12;
        key.shadow.camera.bottom = -6;
        key.shadow.bias = -0.0002;
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x7be8c4, 2.2);
        rim.position.set(6, 4, -5);
        scene.add(rim);
        const fill = new THREE.PointLight(0x91b7ce, 14, 22);
        fill.position.set(-3, 2.5, -2);
        scene.add(fill);

        buildWorld();
        if (usingFallback) {
          drawFallback = () => {
            const ctx = fallbackContext;
            const width = fallbackCanvas.width;
            const heightPx = fallbackCanvas.height;
            if (!ctx || width < 2 || heightPx < 2 || !camera) return;

            const background = ctx.createRadialGradient(width * 0.5, heightPx * 0.58, 10, width * 0.5, heightPx * 0.58, Math.max(width, heightPx) * 0.72);
            background.addColorStop(0, '#202c35');
            background.addColorStop(0.55, '#171e28');
            background.addColorStop(1, '#11151e');
            ctx.clearRect(0, 0, width, heightPx);
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, width, heightPx);

            const eye = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
            const target = { x: 0, y: cameraTargetY, z: 0 };
            const normalize = (v: { x: number; y: number; z: number }) => {
              const length = Math.hypot(v.x, v.y, v.z) || 1;
              return { x: v.x / length, y: v.y / length, z: v.z / length };
            };
            const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z;
            const direction = normalize({ x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z });
            const right = normalize({ x: direction.z, y: 0, z: -direction.x });
            const up = normalize({
              x: right.y * direction.z - right.z * direction.y,
              y: right.z * direction.x - right.x * direction.z,
              z: right.x * direction.y - right.y * direction.x,
            });
            const focal = heightPx / (2 * Math.tan((36 * Math.PI) / 360));
            const project = (point: { x: number; y: number; z: number }) => {
              const relative = { x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z };
              const depth = Math.max(0.1, dot(relative, direction));
              const scale = focal / depth;
              return {
                x: width * 0.5 + dot(relative, right) * scale,
                y: heightPx * 0.52 - dot(relative, up) * scale,
                depth,
              };
            };
            const drawGridLine = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, alpha: number) => {
              const p1 = project(a);
              const p2 = project(b);
              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(p2.x, p2.y);
              ctx.strokeStyle = `rgba(107, 151, 159, ${alpha})`;
              ctx.lineWidth = 1;
              ctx.stroke();
            };
            for (let index = -12; index <= 12; index += 1) {
              drawGridLine({ x: index * 2, y: -0.29, z: -24 }, { x: index * 2, y: -0.29, z: 24 }, index === 0 ? 0.2 : 0.075);
              drawGridLine({ x: -24, y: -0.29, z: index * 2 }, { x: 24, y: -0.29, z: index * 2 }, index === 0 ? 0.2 : 0.075);
            }

            type Face = { points: { x: number; y: number; z: number }[]; color: string; depth: number };
            const faces: Face[] = [];
            const shade = (hex: number, factor: number) => {
              const channel = (shift: number) => Math.max(0, Math.min(255, Math.round(((hex >> shift) & 255) * factor)));
              return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
            };
            const rotate = (point: { x: number; y: number; z: number }, q: any) => {
              const ix = q.w * point.x + q.y * point.z - q.z * point.y;
              const iy = q.w * point.y + q.z * point.x - q.x * point.z;
              const iz = q.w * point.z + q.x * point.y - q.y * point.x;
              const iw = -q.x * point.x - q.y * point.y - q.z * point.z;
              return {
                x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
                y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
                z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
              };
            };
            const addBoxFaces = (position: { x: number; y: number; z: number }, dims: number[], quaternion: any, color: number) => {
              const [w, h, d] = dims;
              const local = [
                { x: -w / 2, y: -h / 2, z: -d / 2 }, { x: w / 2, y: -h / 2, z: -d / 2 },
                { x: w / 2, y: h / 2, z: -d / 2 }, { x: -w / 2, y: h / 2, z: -d / 2 },
                { x: -w / 2, y: -h / 2, z: d / 2 }, { x: w / 2, y: -h / 2, z: d / 2 },
                { x: w / 2, y: h / 2, z: d / 2 }, { x: -w / 2, y: h / 2, z: d / 2 },
              ];
              const vertices = local.map((point) => {
                const rotated = rotate(point, quaternion);
                return { x: rotated.x + position.x, y: rotated.y + position.y, z: rotated.z + position.z };
              });
              const panels = [
                [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1],
                [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2],
              ];
              panels.forEach((indices, index) => {
                const points = indices.map((i) => vertices[i]);
                faces.push({
                  points,
                  color: shade(color, [0.62, 0.78, 0.7, 0.92, 0.52, 1.06][index]),
                  depth: points.reduce((sum, point) => sum + project(point).depth, 0) / points.length,
                });
              });
            };

            addBoxFaces({ x: 0, y: 0, z: 0 }, [3.8, 0.56, 3.8], { x: 0, y: 0, z: 0, w: 1 }, 0x435b63);
            for (const piece of pieces) {
              const dims = piece.body.userData?.dims || [1.4, 1, 1.4];
              if (piece.kind === 'box') {
                addBoxFaces(piece.body.position, dims, piece.body.quaternion, piece.color);
                continue;
              }
              const sides = 10;
              const radius = dims[0] / 2;
              const cylinderHeight = dims[1];
              const rings: { x: number; y: number; z: number }[][] = [[], []];
              for (let index = 0; index < sides; index += 1) {
                const angle = (index / sides) * Math.PI * 2;
                for (let ring = 0; ring < 2; ring += 1) {
                  const localPoint = { x: Math.cos(angle) * radius, y: ring === 0 ? -cylinderHeight / 2 : cylinderHeight / 2, z: Math.sin(angle) * radius };
                  const rotated = rotate(localPoint, piece.body.quaternion);
                  rings[ring].push({ x: rotated.x + piece.body.position.x, y: rotated.y + piece.body.position.y, z: rotated.z + piece.body.position.z });
                }
              }
              for (let index = 0; index < sides; index += 1) {
                const next = (index + 1) % sides;
                const points = [rings[0][index], rings[0][next], rings[1][next], rings[1][index]];
                faces.push({ points, color: shade(piece.color, 0.78 + (index % 3) * 0.08), depth: points.reduce((sum, point) => sum + project(point).depth, 0) / points.length });
              }
              rings.forEach((ring, index) => {
                faces.push({
                  points: ring,
                  color: shade(piece.color, index === 0 ? 0.6 : 1.04),
                  depth: ring.reduce((sum, point) => sum + project(point).depth, 0) / ring.length,
                });
              });
            }

            faces.sort((a, b) => b.depth - a.depth);
            for (const face of faces) {
              const first = project(face.points[0]);
              ctx.beginPath();
              ctx.moveTo(first.x, first.y);
              for (let index = 1; index < face.points.length; index += 1) {
                const point = project(face.points[index]);
                ctx.lineTo(point.x, point.y);
              }
              ctx.closePath();
              ctx.fillStyle = face.color;
              ctx.fill();
              ctx.strokeStyle = 'rgba(226, 255, 247, .16)';
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          };
        }
        const resize = () => {
          if (!renderer || !camera) return;
          const width = renderCanvas.clientWidth || window.innerWidth;
          const heightPx = renderCanvas.clientHeight || window.innerHeight;
          renderer.setSize(width, heightPx, false);
          camera.aspect = width / Math.max(heightPx, 1);
          camera.updateProjectionMatrix();
        };
        resizeHandler = resize;
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(renderCanvas);
        window.addEventListener('resize', resize);

        const loop = (timestamp: number) => {
          if (disposed) return;
          rafId = window.requestAnimationFrame(loop);
          const delta = lastFrameTime ? Math.min((timestamp - lastFrameTime) / 1000, 0.04) : 1 / 60;
          lastFrameTime = timestamp;
          animationTime += delta;
          frameCount += 1;

          if (!gameOver && !paused) {
            world.step(1 / 60, delta, 3);
            let tallest = 0.28;
            let collapsed = false;
            for (const piece of pieces) {
              const body = piece.body;
              piece.mesh.position.set(body.position.x, body.position.y, body.position.z);
              piece.mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
              tallest = Math.max(tallest, body.position.y + ((body.userData?.dims?.[1] || 1) / 2));
              if (body.position.y < -5.5) collapsed = true;

              if (!piece.counted) {
                const linearSpeed = body.velocity.length();
                const angularSpeed = body.angularVelocity.length();
                if (animationTime - piece.born > 0.7 && linearSpeed < 0.16 && angularSpeed < 0.24 && body.position.y > 0.2) {
                  piece.stillFor += delta;
                  if (piece.stillFor > 0.42) {
                    piece.counted = true;
                    body.sleep();
                    setScore((current) => current + 1);
                  }
                } else {
                  piece.stillFor = 0;
                }
              }
            }

            if (collapsed) {
              const fallen = pieces.filter((piece) => piece.body.position.y < -5.5);
              for (const piece of fallen) {
                world.removeBody(piece.body);
                scene.remove(piece.mesh);
                piece.mesh.geometry.dispose();
                piece.mesh.material.dispose();
              }
              pieces = pieces.filter((piece) => piece.body.position.y >= -5.5);
              gameOver = true;
              updateStatus('over');
            }

            const desiredTarget = Math.max(0.65, tallest * 0.42);
            cameraTargetY += (desiredTarget - cameraTargetY) * Math.min(1, delta * 1.7);
            const orbit = animationTime * 0.055;
            const cameraRadius = 12.3;
            camera.position.x += (Math.cos(orbit) * cameraRadius - camera.position.x) * 0.012;
            camera.position.z += (Math.sin(orbit) * cameraRadius - camera.position.z) * 0.012;
            camera.position.y += (cameraTargetY + 6.8 - camera.position.y) * Math.min(1, delta * 1.4);
            camera.lookAt(0, cameraTargetY, 0);

            if (frameCount % 8 === 0) setHeight(Math.max(0, tallest - 0.28));
          }
          renderer.render(scene, camera);
        };

        runtimeRef.current = {
          dispose: () => {},
          restart: restartGame,
          drop: dropPiece,
          setPaused: (value: boolean) => {
            paused = value;
          },
        };
        updateStatus('ready');
        rafId = window.requestAnimationFrame(loop);

        runtimeRef.current.dispose = () => {
          disposed = true;
          window.cancelAnimationFrame(rafId);
          resizeObserver?.disconnect();
          window.removeEventListener('resize', resize);
          resizeHandler = undefined;
          clearPieces();
          if (platformMesh) {
            scene.remove(platformMesh);
            platformMesh.traverse((object: any) => {
              object.geometry?.dispose();
              if (Array.isArray(object.material)) object.material.forEach((material: any) => material.dispose());
              else object.material?.dispose();
            });
          }
          if (grid) {
            scene.remove(grid);
            grid.geometry?.dispose();
            const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
            materials.forEach((material: any) => material.dispose());
          }
          scene.traverse((object: any) => {
            if (object.isLight && object.shadow?.map) object.shadow.map.dispose();
          });
          renderer?.dispose();
          renderer?.forceContextLoss();
          canvas.style.display = '';
          fallbackCanvas.style.display = '';
          runtimeRef.current = null;
        };
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : 'The game engine could not be loaded.';
        setErrorMessage(message);
        updateStatus('error');
      }
    };

    void start();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      gameShell?.removeEventListener('pointerdown', handleCanvasClick);
      window.removeEventListener('keydown', handleKeyDown);
      if (runtimeRef.current) runtimeRef.current.dispose();
      runtimeRef.current = null;
    };
  }, [retry, updateStatus]);

  const restart = () => {
    if (status === 'error') {
      setRetry((value) => value + 1);
      return;
    }
    runtimeRef.current?.restart();
  };

  const togglePause = () => {
    if (status !== 'ready') return;
    const nextPaused = !isPaused;
    setIsPaused(nextPaused);
    runtimeRef.current?.setPaused(nextPaused);
  };

  return (
    <main className={`game-shell ${status === 'loading' ? 'is-loading' : ''} ${status === 'over' ? 'is-over' : ''} ${isPaused ? 'is-paused' : ''}`}>
      <div className="game-canvas-wrap" aria-label="Three-dimensional block stacking game">
        <canvas ref={canvasRef} data-testid="game-canvas" aria-label="Click to drop a physics block" />
        <canvas ref={fallbackCanvasRef} className="fallback-canvas" aria-label="Click to drop a physics block" />
      </div>
      <div className="game-noise" aria-hidden="true" />

      <header className="game-header">
        <div className="brand-lockup">
          <div className="brand-mark"><StackerMark /></div>
          <div>
            <div className="brand-name">Stacker</div>
            <div className="brand-subtitle">A physics challenge</div>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="pause-button"
            onClick={togglePause}
            disabled={status !== 'ready'}
            data-testid="button-pause"
            aria-label={isPaused ? 'Resume game' : 'Pause game'}
          >
            {isPaused ? (
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7.2 4.6 8 5.4-8 5.4V4.6Z" fill="currentColor" /></svg>
            ) : (
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.5 5v10M13.5 5v10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
            )}
            <span>{isPaused ? 'Resume' : 'Pause'}</span>
          </button>
          <div className="session-badge">
            <span className="session-dot" />
            <span>{isPaused ? 'Paused' : status === 'over' ? 'Run complete' : status === 'loading' ? 'Connecting' : 'Live session'}</span>
          </div>
        </div>
      </header>

      <section className="hud" aria-label="Current run statistics">
        <div className="hud-label">Blocks placed</div>
        <div className="score-value" data-testid="text-score">{String(score).padStart(2, '0')}</div>
        <div className="hud-divider" />
        <div className="height-line">
          <span className="height-value" data-testid="text-tower-height">{height.toFixed(1)}</span>
          <span className="height-unit">meters</span>
        </div>
        <div className="hud-caption">Tower height</div>
        <div className="best-height">
          <span className="best-height-label">Best height</span>
          <span className="best-height-value" data-testid="text-best-height">{bestHeight.toFixed(1)}<small>m</small></span>
        </div>
      </section>

      <aside className="next-panel" aria-label="Next block preview">
        <div className="next-panel-heading">
          <div>
            <div className="next-eyebrow">Up next</div>
            <div className="next-title">Next Block</div>
          </div>
          <span className="next-color-dot" style={{ backgroundColor: colorToCss(nextBlock.color) }} />
        </div>
        <div className="next-preview-stage">
          <div
            className={`next-preview-shape ${nextBlock.shape === 'cylinder' ? 'is-cylinder' : 'is-cuboid'}`}
            style={{
              backgroundColor: colorToCss(nextBlock.color),
              width: `${Math.max(48, Math.min(72, nextBlock.dimensions[0] * 42))}px`,
              height: `${Math.max(40, Math.min(58, nextBlock.dimensions[1] * 42))}px`,
              transform: `rotateX(-22deg) rotateY(${previewRotation + 28}deg) rotateZ(-4deg)`,
            }}
          />
          <div className="preview-shadow" />
        </div>
        <div className="next-block-meta">
          <span>{nextBlock.shape === 'cylinder' ? 'Cylinder' : 'Cuboid'}</span>
          <span className="next-block-state">Ready</span>
        </div>
        <div className="landing-position">
          <span>Drop position</span>
          <span>{dropOffset > 0 ? '+' : ''}{dropOffset.toFixed(2)}</span>
        </div>
        <div className="position-meter" aria-hidden="true">
          <span className="position-meter-center" />
          <span className="position-meter-marker" style={{ left: `${50 + dropOffset * 42}%` }} />
        </div>
        <div className="preview-controls">
          <button onClick={() => moveDropPosition(-1)} aria-label="Move block left" data-testid="button-move-left">←</button>
          <button onClick={rotateNextBlock} aria-label="Rotate block" data-testid="button-rotate-block">↻</button>
          <button onClick={() => moveDropPosition(1)} aria-label="Move block right" data-testid="button-move-right">→</button>
        </div>
        <div className="next-controls-hint">← → move · ↑ / R rotate</div>
      </aside>

      <footer className="game-bottom">
        <div>
          <div className="drop-prompt">
            <span className="keycap">SPACE</span>
            <span data-testid="text-game-instruction">Click to drop blocks</span>
          </div>
          <div className="prompt-note">A / D move · R rotate · One block at a time</div>
        </div>
        <button className="restart-button" onClick={restart} disabled={status === 'loading'} data-testid="button-restart" aria-label="Restart the game">
          <RestartIcon />
          <span>Restart</span>
        </button>
      </footer>

      {status === 'loading' && (
        <div className="status-layer" role="status" aria-live="polite" data-testid="status-loading">
          <div className="status-card">
            <div className="status-kicker">Setting the stage</div>
            <h1 className="status-title">A tower in<br />the making.</h1>
            <p className="status-copy">Waking the physics engine and lining up your platform.</p>
            <div className="loading-pips" aria-hidden="true"><span /><span /><span /></div>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="status-layer" role="alert" data-testid="status-error">
          <div className="status-card">
            <div className="status-kicker">Engine unavailable</div>
            <h1 className="status-title">Couldn’t load<br />the physics.</h1>
            <p className="status-copy">Check your connection and try loading the game again.</p>
            <div className="game-error-detail">{errorMessage}</div>
            <button className="primary-button" onClick={restart} data-testid="button-retry">
              <RestartIcon /> Try again
            </button>
          </div>
        </div>
      )}

      {isPaused && status === 'ready' && (
        <div className="pause-layer" role="dialog" aria-modal="true" aria-labelledby="paused-title" data-testid="status-paused">
          <div className="pause-card">
            <div className="status-kicker">Take your time</div>
            <h2 id="paused-title">Game paused</h2>
            <p>The tower is steady. Resume whenever you’re ready.</p>
            <button className="primary-button" onClick={togglePause} data-testid="button-resume">
              <ArrowIcon /> Resume building
            </button>
          </div>
        </div>
      )}

      {status === 'over' && (
        <div className="status-layer" role="dialog" aria-modal="true" aria-labelledby="game-over-title" data-testid="status-game-over">
          <div className="status-card">
            <div className="status-kicker">That’s the edge</div>
            <h1 className="status-title" id="game-over-title">The tower<br />had its moment.</h1>
            <p className="status-copy">The stack gave way. Take what you learned into the next run.</p>
            <div className="status-score" data-testid="text-final-score">{score}</div>
            <div className="status-score-caption">blocks placed</div>
            <button className="primary-button" onClick={restart} data-testid="button-play-again">
              <ArrowIcon /> Build again
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
