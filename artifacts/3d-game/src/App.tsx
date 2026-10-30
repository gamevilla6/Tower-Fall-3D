import { useCallback, useEffect, useRef, useState } from 'react';
import { calculateCameraFrame, createInitialCameraFrame } from './camera-framing';
import {
  BASE_PLATFORM_HALF_EXTENT,
  getCenterOfMassXZ,
  getDifficultyTier,
  getDropSpeedMultiplier,
  getGustInterval,
  getPlacementPoints,
  getPlatformHalfExtent,
  getStreakMultiplier,
  isMysteryBlockNumber,
  isOffCenter,
  isPerfectPlacement,
  type MysteryEffect,
} from './game-mechanics';

type GameStatus = 'loading' | 'ready' | 'over' | 'error';
type Runtime = {
  dispose: () => void;
  restart: () => void;
  drop: () => void;
  setPaused: (paused: boolean) => void;
  setGraphicsQuality: (quality: GraphicsQuality) => void;
};
type BlockPlan = {
  shape: 'box' | 'cylinder';
  color: number;
  dimensions: [number, number, number];
  mysteryEffect?: MysteryEffect;
};
type RunSummary = {
  height: number;
  score: number;
  points: number;
  streak: number;
  bestScore: number;
  newHighScore: boolean;
};
type ComboPulse = {
  id: number;
  streak: number;
  multiplier: number;
  points: number;
};
type GraphicsQuality = 'low' | 'medium' | 'high';
type ControlMode = 'tap' | 'keyboard';
type CameraDistancePreference = 'close' | 'standard' | 'wide';
type GameSettings = {
  soundEffects: boolean;
  backgroundMusic: boolean;
  graphicsQuality: GraphicsQuality;
  controlMode: ControlMode;
  cameraDistance: CameraDistancePreference;
};

const DEFAULT_SETTINGS: GameSettings = {
  soundEffects: true,
  backgroundMusic: false,
  graphicsQuality: 'high',
  controlMode: 'tap',
  cameraDistance: 'standard',
};

function readGameSettings(): GameSettings {
  try {
    const saved = window.localStorage.getItem('stacker-settings');
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<GameSettings>;
    return {
      soundEffects: typeof parsed.soundEffects === 'boolean' ? parsed.soundEffects : DEFAULT_SETTINGS.soundEffects,
      backgroundMusic: typeof parsed.backgroundMusic === 'boolean' ? parsed.backgroundMusic : DEFAULT_SETTINGS.backgroundMusic,
      graphicsQuality: parsed.graphicsQuality === 'low' || parsed.graphicsQuality === 'medium' || parsed.graphicsQuality === 'high'
        ? parsed.graphicsQuality
        : DEFAULT_SETTINGS.graphicsQuality,
      controlMode: parsed.controlMode === 'keyboard' || parsed.controlMode === 'tap'
        ? parsed.controlMode
        : DEFAULT_SETTINGS.controlMode,
      cameraDistance: parsed.cameraDistance === 'close' || parsed.cameraDistance === 'standard' || parsed.cameraDistance === 'wide'
        ? parsed.cameraDistance
        : DEFAULT_SETTINGS.cameraDistance,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const importFromCdn = new Function(
  'url',
  'return import(url)',
) as (url: string) => Promise<any>;

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js';
const CANNON_URL = 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
const BLOCK_COLORS = [0x75e3c0, 0xf28ab0, 0xf0c46b, 0x79c8dc, 0xb89ae9, 0xff9678];

function makeBlockPlan(blockNumber = 1): BlockPlan {
  const shape = Math.random() < 0.27 ? 'cylinder' : 'box';
  let dimensions: [number, number, number];
  if (shape === 'cylinder') {
    const radius = 0.68 + Math.random() * 0.12;
    const height = 0.8 + Math.random() * 0.48;
    dimensions = [radius * 2, height, radius * 2];
  } else {
    const width = 1.25 + Math.random() * 0.42;
    const height = 0.72 + Math.random() * 0.5;
    const depth = 1.2 + Math.random() * 0.42;
    dimensions = [width, height, depth];
  }

  const mysteryEffects: MysteryEffect[] = ['spring', 'heavy', 'mini'];
  const mysteryEffect = isMysteryBlockNumber(blockNumber)
    ? mysteryEffects[Math.floor(Math.random() * mysteryEffects.length)]
    : undefined;
  if (mysteryEffect === 'mini') {
    dimensions = dimensions.map((dimension) => dimension * 0.72) as [number, number, number];
  }

  const color = mysteryEffect
    ? ({ spring: 0xffb357, heavy: 0xb89ae9, mini: 0x73e2ce } as const)[mysteryEffect]
    : BLOCK_COLORS[Math.floor(Math.random() * BLOCK_COLORS.length)];
  return { shape, color, dimensions, mysteryEffect };
}

function makeBlockGeometry(THREE: any, plan: BlockPlan) {
  if (plan.shape === 'cylinder') {
    const radius = plan.dimensions[0] / 2;
    return new THREE.CylinderGeometry(radius, radius, plan.dimensions[1], 10, 1);
  }
  return new THREE.BoxGeometry(...plan.dimensions);
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
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewPlanUpdaterRef = useRef<((plan: BlockPlan) => void) | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const statusRef = useRef<GameStatus>('loading');
  const [status, setStatus] = useState<GameStatus>('loading');
  const [score, setScore] = useState(0);
  const scoreRef = useRef(score);
  scoreRef.current = score;
  const [points, setPoints] = useState(0);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const [streak, setStreak] = useState(0);
  const streakRef = useRef(streak);
  streakRef.current = streak;
  const [height, setHeight] = useState(0);
  const [difficultyTier, setDifficultyTier] = useState(0);
  const [balanceWarning, setBalanceWarning] = useState(false);
  const [windHeading, setWindHeading] = useState<-1 | 1 | null>(null);
  const [comboPulse, setComboPulse] = useState<ComboPulse | null>(null);
  const [bestHeight, setBestHeight] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('stacker-best-height'));
      return Number.isFinite(saved) ? saved : 0;
    } catch {
      return 0;
    }
  });
  const [bestScore, setBestScore] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('stacker-best-score'));
      return Number.isFinite(saved) ? saved : 0;
    } catch {
      return 0;
    }
  });
  const bestScoreRef = useRef(bestScore);
  bestScoreRef.current = bestScore;
  const [finalRunStats, setFinalRunStats] = useState<RunSummary | null>(null);
  const [shareMessage, setShareMessage] = useState('');
  const [showMenu, setShowMenu] = useState(true);
  const [menuExiting, setMenuExiting] = useState(false);
  const [howToPlayOpen, setHowToPlayOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const menuExitTimerRef = useRef<number | undefined>(undefined);
  const isMainMenuRef = useRef(true);
  const [settings, setSettings] = useState<GameSettings>(readGameSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  const [settingsReturnTo, setSettingsReturnTo] = useState<'home' | 'pause'>('home');
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const settingsCloseTimerRef = useRef<number | undefined>(undefined);
  const audioContextRef = useRef<AudioContext | null>(null);
  const musicRef = useRef<{ oscillators: OscillatorNode[]; gain: GainNode } | null>(null);
  const [nextBlock, setNextBlock] = useState<BlockPlan>(makeBlockPlan);
  const [threePreviewActive, setThreePreviewActive] = useState(false);
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

  const getAudioContext = () => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === 'suspended') void audioContextRef.current.resume();
    return audioContextRef.current;
  };

  const playSoundEffect = (kind: 'drop' | 'land') => {
    if (!settingsRef.current.soundEffects) return;
    try {
      const context = getAudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = kind === 'drop' ? 'sine' : 'triangle';
      oscillator.frequency.setValueAtTime(kind === 'drop' ? 420 : 260, now);
      oscillator.frequency.exponentialRampToValueAtTime(kind === 'drop' ? 170 : 390, now + 0.12);
      gain.gain.setValueAtTime(kind === 'drop' ? 0.055 : 0.045, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(now);
      oscillator.stop(now + 0.16);
    } catch {
      // Audio is optional; unavailable devices should not interrupt gameplay.
    }
  };

  const stopBackgroundMusic = () => {
    const music = musicRef.current;
    if (!music) return;
    musicRef.current = null;
    const now = audioContextRef.current?.currentTime ?? 0;
    try {
      music.gain.gain.cancelScheduledValues(now);
      music.gain.gain.setTargetAtTime(0, now, 0.12);
      let remaining = music.oscillators.length;
      for (const oscillator of music.oscillators) {
        oscillator.onended = () => {
          oscillator.disconnect();
          remaining -= 1;
          if (remaining === 0) music.gain.disconnect();
        };
        oscillator.stop(now + 0.5);
      }
    } catch {
      for (const oscillator of music.oscillators) oscillator.disconnect();
      music.gain.disconnect();
    }
  };

  const startBackgroundMusic = () => {
    if (!settingsRef.current.backgroundMusic) return;
    if (musicRef.current) return;
    try {
      const context = getAudioContext();
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.012, context.currentTime + 1.2);
      gain.connect(context.destination);
      const oscillators = [110, 164.81, 220].map((frequency) => {
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start();
        return oscillator;
      });
      musicRef.current = { oscillators, gain };
    } catch {
      // Background audio is optional; gameplay remains available if it fails.
    }
  };

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
    let previewRenderer: any;
    let previewScene: any;
    let previewCamera: any;
    let previewRoot: any;
    let previewMesh: any;
    let previewResizeObserver: ResizeObserver | undefined;
    let previewResizeHandler: (() => void) | undefined;
    const previewCanvas = previewCanvasRef.current;
    let scene: any;
    let camera: any;
    let world: any;
    let THREE: any;
    let CANNON: any;
    let platformMesh: any;
    let platformBody: any;
    let platformShape: any;
    let grid: any;
    let sharedBlockMaterial: any;
    let springBlockMaterial: any;
    let platformHalfExtent = BASE_PLATFORM_HALF_EXTENT;
    let appliedPlatformHalfExtent = BASE_PLATFORM_HALF_EXTENT;
    let platformTargetHalfExtent = BASE_PLATFORM_HALF_EXTENT;
    let activeDifficultyTier = 0;
    let offCenterTime = 0;
    let balanceWarningActive = false;
    let gustRemaining = 0;
    let gustDuration = 0;
    let gustAcceleration = 0;
    let gustSign: -1 | 1 = 1;
    let nextGustAtScore = 4;
    let comboSequence = 0;
    let animationTime = 0;
    let frameCount = 0;
    let lastFrameTime = 0;
    const initialCameraFrame = createInitialCameraFrame();
    let cameraTargetY = initialCameraFrame.targetY;
    let cameraDistance = initialCameraFrame.distance;
    const cameraElevation = 0.5;
    const cameraOrbitOffset = Math.atan2(9.6, 7.6);
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
      mysteryEffect?: MysteryEffect;
    };
    let pieces: Piece[] = [];

    updateStatus('loading');
    setErrorMessage('');
    setThreePreviewActive(false);

    const updatePreviewPlan = (plan: BlockPlan) => {
      if (!THREE || !previewScene || !previewRoot) return;
      if (previewMesh) {
        previewRoot.remove(previewMesh);
        previewMesh.geometry?.dispose();
        previewMesh.material?.dispose();
      }
      const geometry = makeBlockGeometry(THREE, plan);
      const material = new THREE.MeshStandardMaterial({
        color: plan.color,
        roughness: 0.3,
        metalness: 0.12,
        emissive: plan.color,
        emissiveIntensity: 0.04,
      });
      previewMesh = new THREE.Mesh(geometry, material);
      previewMesh.castShadow = false;
      previewMesh.receiveShadow = false;
      previewRoot.add(previewMesh);
    };

    const disposePreview = () => {
      previewResizeObserver?.disconnect();
      previewResizeObserver = undefined;
      if (previewResizeHandler) window.removeEventListener('resize', previewResizeHandler);
      previewResizeHandler = undefined;
      previewPlanUpdaterRef.current = null;
      if (previewMesh) {
        previewRoot?.remove(previewMesh);
        previewMesh.geometry?.dispose();
        previewMesh.material?.dispose();
        previewMesh = null;
      }
      previewRenderer?.dispose();
      previewRenderer?.forceContextLoss();
      previewRenderer = null;
      previewScene = null;
      previewCamera = null;
      previewRoot = null;
      setThreePreviewActive(false);
    };

    const initializePreviewRenderer = () => {
      if (!previewCanvas || !THREE || usingFallback) return;
      let context: WebGL2RenderingContext | null = null;
      try {
        context = previewCanvas.getContext('webgl2', {
          antialias: true,
          alpha: true,
          powerPreference: 'low-power',
        });
        if (!context) return;
        previewRenderer = new THREE.WebGLRenderer({
          canvas: previewCanvas,
          context,
          antialias: true,
          alpha: true,
          powerPreference: 'low-power',
        });
        previewRenderer.setClearColor(0x000000, 0);
        previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
        previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
        previewRenderer.toneMappingExposure = 1.08;
        previewRenderer.shadowMap.enabled = false;

        previewScene = new THREE.Scene();
        previewRoot = new THREE.Group();
        previewScene.add(previewRoot);
        previewScene.add(new THREE.HemisphereLight(0xeaffff, 0x29414d, 1.85));

        const keyLight = new THREE.DirectionalLight(0xffffff, 2.25);
        keyLight.position.set(-3.5, 4.5, 4);
        previewScene.add(keyLight);
        const fillLight = new THREE.PointLight(0x7be8f2, 1.35);
        fillLight.position.set(3, 1.5, 2.5);
        previewScene.add(fillLight);
        const rimLight = new THREE.PointLight(0x9e91ff, 1.1);
        rimLight.position.set(-2.5, 1, -3);
        previewScene.add(rimLight);

        previewCamera = new THREE.OrthographicCamera(-1.8, 1.8, 1.3, -1.3, 0.1, 30);
        previewCamera.position.set(3.7, 2.8, 4.2);
        previewCamera.lookAt(0, 0, 0);

        const resizePreview = () => {
          if (!previewRenderer || !previewCamera || !previewCanvas) return;
          const width = Math.max(1, previewCanvas.clientWidth);
          const height = Math.max(1, previewCanvas.clientHeight);
          const aspect = width / height;
          const viewHeight = 2.55;
          previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
          previewRenderer.setSize(width, height, false);
          previewCamera.left = -(viewHeight * aspect) / 2;
          previewCamera.right = (viewHeight * aspect) / 2;
          previewCamera.top = viewHeight / 2;
          previewCamera.bottom = -viewHeight / 2;
          previewCamera.updateProjectionMatrix();
        };
        previewResizeHandler = resizePreview;
        previewResizeObserver = new ResizeObserver(resizePreview);
        previewResizeObserver.observe(previewCanvas.parentElement || previewCanvas);
        window.addEventListener('resize', resizePreview);
        resizePreview();

        previewPlanUpdaterRef.current = updatePreviewPlan;
        updatePreviewPlan(nextBlockRef.current);
        setThreePreviewActive(true);
      } catch {
        disposePreview();
        if (!context?.isContextLost()) {
          context?.getExtension('WEBGL_lose_context')?.loseContext();
        }
      }
    };

    const disposePiece = (piece: Piece) => {
      if (world) world.removeBody(piece.body);
      if (scene) scene.remove(piece.mesh);
      piece.mesh.geometry?.dispose();
      if (Array.isArray(piece.mesh.material)) {
        piece.mesh.material.forEach((material: any) => material.dispose());
      } else {
        piece.mesh.material?.dispose();
      }
    };

    const clearPieces = () => {
      for (const piece of pieces) {
        disposePiece(piece);
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
      springBlockMaterial = new CANNON.Material('mystery-spring');
      world.addContactMaterial(new CANNON.ContactMaterial(floorMaterial, sharedBlockMaterial, {
        friction: 0.58,
        restitution: 0.12,
      }));
      world.addContactMaterial(new CANNON.ContactMaterial(sharedBlockMaterial, sharedBlockMaterial, {
        friction: 0.62,
        restitution: 0.08,
      }));
      world.addContactMaterial(new CANNON.ContactMaterial(floorMaterial, springBlockMaterial, {
        friction: 0.5,
        restitution: 0.78,
      }));
      world.addContactMaterial(new CANNON.ContactMaterial(sharedBlockMaterial, springBlockMaterial, {
        friction: 0.52,
        restitution: 0.7,
      }));
      world.addContactMaterial(new CANNON.ContactMaterial(springBlockMaterial, springBlockMaterial, {
        friction: 0.48,
        restitution: 0.72,
      }));

      platformHalfExtent = BASE_PLATFORM_HALF_EXTENT;
      appliedPlatformHalfExtent = BASE_PLATFORM_HALF_EXTENT;
      platformTargetHalfExtent = BASE_PLATFORM_HALF_EXTENT;
      platformShape = new CANNON.Box(new CANNON.Vec3(platformHalfExtent, 0.28, platformHalfExtent));
      platformBody = new CANNON.Body({ mass: 0, material: floorMaterial });
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
      platformMesh.scale.set(1, 1, 1);
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

    const applyGraphicsQuality = (quality: GraphicsQuality) => {
      if (!renderer) return;
      const pixelRatioLimit = quality === 'low' ? 0.75 : quality === 'medium' ? 1.25 : 2;
      const width = renderCanvas.clientWidth || window.innerWidth;
      const heightPx = renderCanvas.clientHeight || window.innerHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioLimit));
      renderer.setSize(width, heightPx, false);
      if (!usingFallback && renderer.shadowMap && THREE) {
        renderer.shadowMap.enabled = quality !== 'low';
        renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
        renderer.shadowMap.needsUpdate = true;
      }
    };

    const restartGame = () => {
      if (!world || !THREE || disposed) return;
      gameOver = false;
      paused = false;
      controlsRef.current = { x: 0, rotation: 0 };
      setDropOffset(0);
      setPreviewRotation(0);
      setIsPaused(false);
      setFinalRunStats(null);
      setShareMessage('');
      setPoints(0);
      pointsRef.current = 0;
      setStreak(0);
      streakRef.current = 0;
      setComboPulse(null);
      setBalanceWarning(false);
      balanceWarningActive = false;
      offCenterTime = 0;
      setWindHeading(null);
      gustRemaining = 0;
      gustDuration = 0;
      gustAcceleration = 0;
      nextGustAtScore = 1 + getGustInterval(Math.random());
      setDifficultyTier(0);
      activeDifficultyTier = 0;
      platformHalfExtent = BASE_PLATFORM_HALF_EXTENT;
      platformTargetHalfExtent = BASE_PLATFORM_HALF_EXTENT;
      const firstBlock = makeBlockPlan(1);
      nextBlockRef.current = firstBlock;
      setNextBlock(firstBlock);
      previewPlanUpdaterRef.current?.(firstBlock);
      buildWorld();
      const initialCameraFrame = createInitialCameraFrame();
      cameraTargetY = initialCameraFrame.targetY;
      cameraDistance = initialCameraFrame.distance;
      scoreRef.current = 0;
      setScore(0);
      setHeight(0);
      updateStatus('ready');
    };

    const dropPiece = () => {
      if (!world || !THREE || disposed || gameOver || paused || isMainMenuRef.current || statusRef.current !== 'ready') return;
      if (pieces.some((piece) => !piece.counted)) return;
      playSoundEffect('drop');
      const plan = nextBlockRef.current;
      const color = plan.color;
      const material = plan.mysteryEffect === 'spring' ? springBlockMaterial : sharedBlockMaterial;
      const settledTowerTop = pieces.reduce((top, piece) => {
        const halfHeight = (piece.body.userData?.dims?.[1] || 1) / 2;
        const pieceTop = piece.body.position.y + halfHeight;
        return Number.isFinite(pieceTop) ? Math.max(top, pieceTop) : top;
      }, 0.28);
      const meshMaterial = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.27,
        metalness: 0.18,
        emissive: color,
        emissiveIntensity: plan.mysteryEffect ? 0.18 : 0.055,
      });
      const geometry = makeBlockGeometry(THREE, plan);
      let shape: any;
      let mass = 1.8;
      const dims = plan.dimensions;

      if (plan.shape === 'cylinder') {
        const radius = dims[0] / 2;
        shape = new CANNON.Cylinder(radius, radius, dims[1], 10);
        mass = 1.9;
      } else {
        shape = new CANNON.Box(new CANNON.Vec3(dims[0] / 2, dims[1] / 2, dims[2] / 2));
      }
      if (plan.mysteryEffect === 'heavy') mass *= 2.6;
      if (plan.mysteryEffect === 'mini') mass *= 0.72 ** 3;

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
      body.position.set(controlsRef.current.x, Math.max(2.9, settledTowerTop + 2.7), (Math.random() - 0.5) * 0.18);
      body.quaternion.setFromEuler(
        (Math.random() - 0.5) * 0.08,
        controlsRef.current.rotation,
        (Math.random() - 0.5) * 0.08,
      );
      body.velocity.set((Math.random() - 0.5) * 0.2, 0, (Math.random() - 0.5) * 0.2);
      body.angularVelocity.set((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.25);
      body.userData = { dims, mysteryEffect: plan.mysteryEffect };
      world.addBody(body);
      pieces.push({
        body,
        mesh,
        kind: plan.shape,
        born: animationTime,
        stillFor: 0,
        counted: false,
        color,
        mysteryEffect: plan.mysteryEffect,
      });
      const following = makeBlockPlan(scoreRef.current + 2);
      nextBlockRef.current = following;
      setNextBlock(following);
      previewPlanUpdaterRef.current?.(following);
      controlsRef.current = { x: 0, rotation: 0 };
      setDropOffset(0);
      setPreviewRotation(0);
    };

    const gameShell = canvas.closest('.game-shell');
    const handleCanvasClick = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, input, textarea, select, a, [role="button"]')) return;
      if (settingsRef.current.controlMode !== 'tap') return;
      dropPiece();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, input, textarea, select, a, [role="button"]')) return;
      if (event.code === 'Space') {
        if (settingsRef.current.controlMode !== 'keyboard') return;
        if (event.repeat) return;
        event.preventDefault();
        dropPiece();
        return;
      }
      if (settingsRef.current.controlMode !== 'keyboard' || statusRef.current !== 'ready' || paused) return;
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
          const context = canvas.getContext('webgl2', {
            antialias: settingsRef.current.graphicsQuality !== 'low',
            alpha: true,
            powerPreference: 'high-performance',
          });
          if (!context) throw new Error('WebGL2 is unavailable in this browser context.');
          renderer = new THREE.WebGLRenderer({
            canvas,
            context,
            antialias: settingsRef.current.graphicsQuality !== 'low',
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
        applyGraphicsQuality(settingsRef.current.graphicsQuality);
        if (!usingFallback) {
          renderer.outputColorSpace = THREE.SRGBColorSpace;
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.22;
        }
        initializePreviewRenderer();

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x151b24);
        scene.fog = new THREE.FogExp2(0x151b24, 0.019);
        camera = new THREE.PerspectiveCamera(36, 1, 0.1, 1000);
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
            const right = normalize({ x: -direction.z, y: 0, z: direction.x });
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

            addBoxFaces(
              { x: 0, y: 0, z: 0 },
              [platformHalfExtent * 2, 0.56, platformHalfExtent * 2],
              { x: 0, y: 0, z: 0, w: 1 },
              0x435b63,
            );
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
          applyGraphicsQuality(settingsRef.current.graphicsQuality);
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
          const elapsed = lastFrameTime ? (timestamp - lastFrameTime) / 1000 : 1 / 60;
          const delta = Math.max(0, Math.min(elapsed, 0.05));
          lastFrameTime = timestamp;
          animationTime += delta;
          frameCount += 1;

          if (!gameOver && !paused) {
            const malformedBeforeStep = pieces.filter((piece) => {
              const body = piece.body;
              return ![
                body.position.x, body.position.y, body.position.z,
                body.velocity.x, body.velocity.y, body.velocity.z,
                body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w,
              ].every(Number.isFinite);
            });
            for (const piece of malformedBeforeStep) disposePiece(piece);
            if (malformedBeforeStep.length) pieces = pieces.filter((piece) => !malformedBeforeStep.includes(piece));

            const dropSpeedMultiplier = getDropSpeedMultiplier(scoreRef.current);
            for (const piece of pieces) {
              if (!piece.counted && piece.body.mass > 0) {
                piece.body.force.y -= piece.body.mass * 9.82 * (dropSpeedMultiplier - 1);
              }
            }
            if (gustRemaining > 0) {
              const gustProgress = Math.min(1, Math.max(0, (gustDuration - gustRemaining) / gustDuration));
              const gustEnvelope = 0.3 + 0.7 * Math.sin(Math.PI * gustProgress);
              for (const piece of pieces) {
                if (piece.body.mass <= 0) continue;
                piece.body.wakeUp();
                piece.body.force.x += gustSign * gustAcceleration * gustEnvelope * piece.body.mass;
              }
              gustRemaining = Math.max(0, gustRemaining - delta);
              if (gustRemaining === 0) setWindHeading(null);
            }

            world.step(1 / 120, delta, 8);
            let tallest = 0.28;
            let settledTowerTop = 0.28;
            let activeBlockTop = 0.28;
            let collapsed = malformedBeforeStep.length > 0;
            const removedPieces = new Set<Piece>(malformedBeforeStep);
            for (const piece of pieces) {
              const body = piece.body;
              const bodyValues = [
                body.position.x, body.position.y, body.position.z,
                body.velocity.x, body.velocity.y, body.velocity.z,
                body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w,
              ];
              if (!bodyValues.every(Number.isFinite)) {
                removedPieces.add(piece);
                collapsed = true;
                continue;
              }
              if (body.position.y < -10) {
                removedPieces.add(piece);
                collapsed = true;
                continue;
              }
              const interpolatedPosition = body.interpolatedPosition;
              const interpolatedQuaternion = body.interpolatedQuaternion;
              const renderPosition = interpolatedPosition
                && [interpolatedPosition.x, interpolatedPosition.y, interpolatedPosition.z].every(Number.isFinite)
                ? interpolatedPosition
                : body.position;
              const renderQuaternion = interpolatedQuaternion
                && [interpolatedQuaternion.x, interpolatedQuaternion.y, interpolatedQuaternion.z, interpolatedQuaternion.w].every(Number.isFinite)
                ? interpolatedQuaternion
                : body.quaternion;
              piece.mesh.position.set(renderPosition.x, renderPosition.y, renderPosition.z);
              piece.mesh.quaternion.set(renderQuaternion.x, renderQuaternion.y, renderQuaternion.z, renderQuaternion.w);
              const pieceTop = body.position.y + ((body.userData?.dims?.[1] || 1) / 2);
              tallest = Math.max(tallest, pieceTop);
              if (piece.counted) settledTowerTop = Math.max(settledTowerTop, pieceTop);
              else activeBlockTop = Math.max(activeBlockTop, pieceTop);

              if (!piece.counted) {
                const linearSpeed = body.velocity.length();
                const angularSpeed = body.angularVelocity.length();
                if (animationTime - piece.born > 0.7 && linearSpeed < 0.16 && angularSpeed < 0.24 && body.position.y > 0.2) {
                  piece.stillFor += delta;
                  if (piece.stillFor > 0.42) {
                    const supportPositions = pieces
                      .filter((other) => other !== piece && other.counted)
                      .map((other) => ({
                        x: other.body.position.x,
                        z: other.body.position.z,
                        mass: other.body.mass,
                      }));
                    const supportCenter = getCenterOfMassXZ(supportPositions);
                    const distanceFromCenter = Math.hypot(
                      body.position.x - supportCenter.x,
                      body.position.z - supportCenter.z,
                    );
                    const perfect = isPerfectPlacement(distanceFromCenter, linearSpeed, angularSpeed);
                    const nextStreak = streakRef.current + 1;
                    const streakMultiplier = getStreakMultiplier(nextStreak);
                    const multiplier = Math.min(3, streakMultiplier * (perfect ? 1.5 : 1));
                    const pointsEarned = getPlacementPoints(nextStreak, perfect);
                    piece.counted = true;
                    body.sleep();
                    scoreRef.current += 1;
                    streakRef.current = nextStreak;
                    pointsRef.current += pointsEarned;
                    setScore(scoreRef.current);
                    setStreak(nextStreak);
                    setPoints(pointsRef.current);
                    if (perfect) {
                      setComboPulse({
                        id: ++comboSequence,
                        streak: nextStreak,
                        multiplier,
                        points: pointsEarned,
                      });
                    }
                    playSoundEffect('land');
                    if (scoreRef.current >= nextGustAtScore && gustRemaining <= 0) {
                      gustDuration = 1.45;
                      gustRemaining = gustDuration;
                      gustSign = Math.random() < 0.5 ? -1 : 1;
                      gustAcceleration = 0.42 + Math.min(0.2, scoreRef.current * 0.008);
                      setWindHeading(gustSign);
                      for (const stackedPiece of pieces) stackedPiece.body.wakeUp();
                      nextGustAtScore = scoreRef.current + getGustInterval(Math.random());
                    }
                  }
                } else {
                  piece.stillFor = 0;
                }
              }
            }

            const towerHeightMeters = Math.max(0, tallest - 0.28);
            const nextDifficultyTier = getDifficultyTier(towerHeightMeters);
            if (nextDifficultyTier !== activeDifficultyTier) {
              activeDifficultyTier = nextDifficultyTier;
              setDifficultyTier(nextDifficultyTier);
            }
            platformTargetHalfExtent = getPlatformHalfExtent(towerHeightMeters);
            const platformEase = 1 - Math.exp(-0.14 * delta);
            platformHalfExtent += (platformTargetHalfExtent - platformHalfExtent) * platformEase;
            if (platformShape && platformBody && platformMesh) {
              if (Math.abs(platformHalfExtent - appliedPlatformHalfExtent) > 0.001) {
                platformShape.halfExtents.set(platformHalfExtent, 0.28, platformHalfExtent);
                platformShape.updateConvexPolyhedronRepresentation();
                platformShape.updateBoundingSphereRadius();
                platformBody.updateBoundingRadius();
                platformBody.updateAABB();
                platformBody.aabbNeedsUpdate = true;
                if (world.broadphase) world.broadphase.dirty = true;
                appliedPlatformHalfExtent = platformHalfExtent;
              }
              const platformScale = platformHalfExtent / BASE_PLATFORM_HALF_EXTENT;
              platformMesh.scale.x = platformScale;
              platformMesh.scale.z = platformScale;
            }

            const countedPositions = pieces
              .filter((piece) => piece.counted)
              .map((piece) => ({
                x: piece.body.position.x,
                z: piece.body.position.z,
                mass: piece.body.mass,
              }));
            if (countedPositions.length > 0) {
              const center = getCenterOfMassXZ(countedPositions);
              const warningThreshold = Math.max(0.55, platformHalfExtent * 0.45);
              if (isOffCenter(center.x, center.z, warningThreshold)) {
                offCenterTime += delta;
                if (offCenterTime >= 2 && !balanceWarningActive) {
                  balanceWarningActive = true;
                  setBalanceWarning(true);
                }
              } else {
                offCenterTime = 0;
                if (balanceWarningActive && !isOffCenter(center.x, center.z, warningThreshold - 0.12)) {
                  balanceWarningActive = false;
                  setBalanceWarning(false);
                }
              }
            } else {
              offCenterTime = 0;
              if (balanceWarningActive) {
                balanceWarningActive = false;
                setBalanceWarning(false);
              }
            }

            if (collapsed) {
              for (const piece of removedPieces) {
                if (!malformedBeforeStep.includes(piece)) disposePiece(piece);
              }
              pieces = pieces.filter((piece) => !removedPieces.has(piece));
              gameOver = true;
              stopBackgroundMusic();
              setWindHeading(null);
              setBalanceWarning(false);
              const runScore = scoreRef.current;
              const runHeight = Math.max(0, Math.round((tallest - 0.28) * 10) / 10);
              const previousBest = bestScoreRef.current;
              const newHighScore = runScore > previousBest;
              const best = Math.max(previousBest, runScore);
              if (newHighScore) {
                bestScoreRef.current = best;
                setBestScore(best);
                try {
                  window.localStorage.setItem('stacker-best-score', String(best));
                } catch {
                  // The run summary remains available even if browser storage is unavailable.
                }
              }
              setFinalRunStats({
                height: runHeight,
                score: runScore,
                points: pointsRef.current,
                streak: streakRef.current,
                bestScore: best,
                newHighScore,
              });
              setShareMessage('');
              updateStatus('over');
            }

            const frame = calculateCameraFrame({
              settledTowerTop,
              activeBlockTop,
              aspect: camera.aspect,
              fov: camera.fov,
              cameraElevation,
              distancePreference: settingsRef.current.cameraDistance,
            });
            const targetAlpha = 1 - Math.exp(-1.8 * delta);
            const cameraAlpha = 1 - Math.exp(-1.55 * delta);
            cameraTargetY += (frame.targetY - cameraTargetY) * targetAlpha;
            cameraDistance += (frame.distance - cameraDistance) * (1 - Math.exp(-1.25 * delta));

            const orbit = animationTime * 0.055 + cameraOrbitOffset;
            const horizontalRadius = cameraDistance * Math.cos(cameraElevation);
            const cameraHeight = cameraDistance * Math.sin(cameraElevation);
            camera.position.x += (Math.cos(orbit) * horizontalRadius - camera.position.x) * cameraAlpha;
            camera.position.z += (Math.sin(orbit) * horizontalRadius - camera.position.z) * cameraAlpha;
            camera.position.y += (cameraTargetY + cameraHeight - camera.position.y) * cameraAlpha;
            if (scene.fog) scene.fog.density = Math.max(0.004, 0.019 * (14 / cameraDistance));
            camera.lookAt(0, cameraTargetY, 0);

            if (frameCount % 8 === 0) setHeight(Math.max(0, tallest - 0.28));
          }
          renderer.render(scene, camera);
          if (!isMainMenuRef.current && previewRenderer && previewScene && previewCamera && previewRoot) {
            previewRoot.rotation.y = controlsRef.current.rotation + animationTime * 0.28;
            previewRoot.rotation.x = 0.12 + Math.sin(animationTime * 0.36) * 0.035;
            try {
              previewRenderer.render(previewScene, previewCamera);
            } catch {
              disposePreview();
            }
          }
        };

        runtimeRef.current = {
          dispose: () => {},
          restart: restartGame,
          drop: dropPiece,
          setPaused: (value: boolean) => {
            paused = value;
          },
          setGraphicsQuality: applyGraphicsQuality,
        };
        updateStatus('ready');
        rafId = window.requestAnimationFrame(loop);

        runtimeRef.current.dispose = () => {
          disposed = true;
          window.cancelAnimationFrame(rafId);
          resizeObserver?.disconnect();
          window.removeEventListener('resize', resize);
          resizeHandler = undefined;
          disposePreview();
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
        disposePreview();
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
      if (menuExitTimerRef.current !== undefined) window.clearTimeout(menuExitTimerRef.current);
      if (settingsCloseTimerRef.current !== undefined) window.clearTimeout(settingsCloseTimerRef.current);
      if (runtimeRef.current) runtimeRef.current.dispose();
      disposePreview();
      runtimeRef.current = null;
      stopBackgroundMusic();
      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [retry, updateStatus]);

  const restart = () => {
    if (status === 'error') {
      setRetry((value) => value + 1);
      return;
    }
    isMainMenuRef.current = false;
    setMenuExiting(false);
    if (menuExitTimerRef.current !== undefined) window.clearTimeout(menuExitTimerRef.current);
    setShowMenu(false);
    runtimeRef.current?.restart();
    startBackgroundMusic();
  };

  const togglePause = () => {
    if (status !== 'ready') return;
    const nextPaused = !isPaused;
    setIsPaused(nextPaused);
    runtimeRef.current?.setPaused(nextPaused);
    if (nextPaused) stopBackgroundMusic();
    else startBackgroundMusic();
  };

  const openSettings = (returnTo: 'home' | 'pause') => {
    if (settingsCloseTimerRef.current !== undefined) window.clearTimeout(settingsCloseTimerRef.current);
    setSettingsReturnTo(returnTo);
    setResetConfirmOpen(false);
    setSettingsClosing(false);
    setSettingsOpen(true);
  };

  const persistSettings = (next: GameSettings) => {
    try {
      window.localStorage.setItem('stacker-settings', JSON.stringify(next));
    } catch {
      // Settings remain available for this session when browser storage is unavailable.
    }
  };

  const updateSettings = (patch: Partial<GameSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    persistSettings(next);
    if (patch.graphicsQuality) runtimeRef.current?.setGraphicsQuality(next.graphicsQuality);
    if (patch.backgroundMusic !== undefined) {
      if (next.backgroundMusic && statusRef.current !== 'over' && statusRef.current !== 'error' && !isPaused) startBackgroundMusic();
      else stopBackgroundMusic();
    }
  };

  const closeSettings = () => {
    if (settingsClosing) return;
    persistSettings(settingsRef.current);
    setSettingsClosing(true);
    settingsCloseTimerRef.current = window.setTimeout(() => {
      setSettingsOpen(false);
      setSettingsClosing(false);
      setResetConfirmOpen(false);
      settingsCloseTimerRef.current = undefined;
    }, 200);
  };

  const resetProgress = () => {
    try {
      window.localStorage.removeItem('stacker-best-height');
      window.localStorage.removeItem('stacker-best-score');
    } catch {
      // The in-memory records are still cleared if storage is unavailable.
    }
    bestScoreRef.current = 0;
    setBestScore(0);
    setBestHeight(0);
    setHeight(0);
    setScore(0);
    scoreRef.current = 0;
    setPoints(0);
    pointsRef.current = 0;
    setStreak(0);
    streakRef.current = 0;
    setComboPulse(null);
    runtimeRef.current?.restart();
    if (settingsReturnTo === 'pause') {
      runtimeRef.current?.setPaused(true);
      setIsPaused(true);
    }
    setResetConfirmOpen(false);
  };

  const openMainMenu = () => {
    stopBackgroundMusic();
    runtimeRef.current?.restart();
    isMainMenuRef.current = true;
    setMenuExiting(false);
    setShowMenu(true);
    startBackgroundMusic();
  };

  const startFromMenu = () => {
    if (status !== 'ready' || menuExiting) return;
    startBackgroundMusic();
    setMenuExiting(true);
    setHowToPlayOpen(false);
    setLeaderboardOpen(false);
    runtimeRef.current?.restart();
    menuExitTimerRef.current = window.setTimeout(() => {
      isMainMenuRef.current = false;
      setShowMenu(false);
      setMenuExiting(false);
      menuExitTimerRef.current = undefined;
    }, 440);
  };

  const openHowToPlay = () => {
    setHowToPlayOpen(true);
    setLeaderboardOpen(false);
  };

  const closeHomeModal = () => {
    setHowToPlayOpen(false);
    setLeaderboardOpen(false);
  };

  const openLeaderboard = () => {
    setLeaderboardOpen(true);
    setHowToPlayOpen(false);
  };

  const shareScore = async () => {
    if (!finalRunStats) return;
    const message = `I stacked ${finalRunStats.score} blocks, scored ${finalRunStats.points} points, and reached ${finalRunStats.height.toFixed(1)}m in Stacker. Can you beat it?`;
    try {
      if (navigator.share) {
        try {
          await navigator.share({ title: 'My Stacker run', text: message });
          setShareMessage('Score shared');
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
        }
      }
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(message);
      setShareMessage('Score copied to clipboard');
    } catch {
      setShareMessage('Could not share this score from your browser');
    }
  };

  return (
    <main className={`game-shell ${status === 'loading' ? 'is-loading' : ''} ${status === 'over' ? 'is-over' : ''} ${isPaused ? 'is-paused' : ''} ${showMenu && !menuExiting ? 'is-menu' : ''}`}>
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

      <div className="hud-rail" role="group" aria-label="Game HUD">
        <section className="hud" aria-label="Current run statistics">
          <div className="hud-label">Blocks placed</div>
          <div className="score-value" data-testid="text-score">{String(score).padStart(2, '0')}</div>
          <div className="hud-divider" />
          <div className="height-line">
            <span className="height-value" data-testid="text-tower-height">{height.toFixed(1)}</span>
            <span className="height-unit">meters</span>
          </div>
          <div className="hud-caption">Tower height</div>
          <div className="bonus-readout" aria-label="Points and streak">
            <div className="bonus-readout-row">
              <span>Points</span>
              <strong data-testid="text-points">{points.toLocaleString()}</strong>
            </div>
            <div className="bonus-readout-row">
              <span>Streak</span>
              <strong data-testid="text-streak">{streak} <small>×{getStreakMultiplier(streak).toFixed(2).replace(/0$/, '')}</small></strong>
            </div>
            <div className="bonus-readout-row difficulty-readout">
              <span>Level {difficultyTier + 1}</span>
              <strong data-testid="text-drop-speed">Drop ×{getDropSpeedMultiplier(score).toFixed(1)}</strong>
            </div>
          </div>
          {balanceWarning && (
            <div className="challenge-warning" role="status" data-testid="status-balance-warning">
              <span className="warning-pulse" />
              TOWER LEANING
            </div>
          )}
          {windHeading !== null && (
            <div className="wind-warning" role="status" data-testid="status-wind-gust">
              WIND GUST {windHeading < 0 ? '←' : '→'}
            </div>
          )}
          <div className="best-height">
            <span className="best-height-label">Best height</span>
            <span className="best-height-value" data-testid="text-best-height">{bestHeight.toFixed(1)}<small>m</small></span>
          </div>
        </section>

        <aside className={`next-panel ${nextBlock.mysteryEffect ? 'is-mystery' : ''}`} aria-label="Next block preview">
          <div className="next-panel-heading">
            <div>
              <div className="next-eyebrow">Next Block:</div>
              <div className="next-title">{nextBlock.mysteryEffect ? 'Mystery Block' : 'Shape preview'}</div>
            </div>
            <span className="next-color-dot" style={{ backgroundColor: colorToCss(nextBlock.color) }} />
          </div>
          <div className={`next-preview-stage ${threePreviewActive ? 'has-three-renderer' : ''}`}>
            <canvas ref={previewCanvasRef} className="next-preview-canvas" aria-hidden="true" />
            {!threePreviewActive && (
              <>
                <div className="preview-fallback-rotator">
                  <div
                    className={`next-preview-shape ${nextBlock.shape === 'cylinder' ? 'is-cylinder' : 'is-cuboid'}`}
                    style={{
                      backgroundColor: colorToCss(nextBlock.color),
                      width: `${Math.max(48, Math.min(72, nextBlock.dimensions[0] * 42))}px`,
                      height: `${Math.max(40, Math.min(58, nextBlock.dimensions[1] * 42))}px`,
                      transform: `rotateX(-22deg) rotateY(${previewRotation + 28}deg) rotateZ(-4deg)`,
                    }}
                  />
                </div>
                <div className="preview-shadow" />
              </>
            )}
          </div>
          <div className="next-block-meta">
            <span>{nextBlock.shape === 'cylinder' ? 'Cylinder' : 'Cuboid'}</span>
            <span className={`next-block-state ${nextBlock.mysteryEffect ? 'is-mystery' : ''}`}>
              {nextBlock.mysteryEffect
                ? nextBlock.mysteryEffect === 'spring' ? 'BOUNCY' : nextBlock.mysteryEffect === 'heavy' ? 'HEAVY' : 'MINI'
                : 'READY'}
            </span>
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
          <div className="next-controls-hint">
            {settings.controlMode === 'keyboard' ? '← → move · ↑ / R rotate' : 'Use buttons to move · rotate'}
          </div>
        </aside>
      </div>

      <footer className="game-bottom">
        <div>
          <div className="drop-prompt">
            <span className="keycap">SPACE</span>
            <span data-testid="text-game-instruction">{settings.controlMode === 'tap' ? 'Click to drop blocks' : 'Press SPACE to drop blocks'}</span>
          </div>
          <div className="prompt-note">
            {settings.controlMode === 'keyboard' ? 'A / D move · R rotate · One block at a time' : 'Use preview buttons to move · One block at a time'}
          </div>
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
            <button className="pause-settings-button" onClick={() => openSettings('pause')} data-testid="button-pause-settings">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8.2 2.6h3.6l.5 1.8 1.3.8 1.8-.4 1.8 3.1-1.3 1.4v1.5l1.3 1.4 1.8 3.1-1.8-.4-1.3.8-.5 1.8H8.2l-.5-1.8-1.3-.8-1.8.4-1.8-3.1 1.3-1.4v-1.5L2.8 8l1.8-3.1 1.8.4 1.3-.8.5-1.9Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><circle cx="10" cy="10.1" r="2.4" stroke="currentColor" strokeWidth="1.2"/></svg>
              Settings
            </button>
          </div>
        </div>
      )}

      {comboPulse && status === 'ready' && (
        <div className="combo-feedback" key={comboPulse.id} role="status" aria-live="polite" data-testid="status-perfect-combo">
          <span className="combo-spark combo-spark-one" aria-hidden="true" />
          <span className="combo-spark combo-spark-two" aria-hidden="true" />
          <span className="combo-spark combo-spark-three" aria-hidden="true" />
          <strong>PERFECT COMBO!</strong>
          <span>+{comboPulse.points} POINTS · ×{comboPulse.multiplier.toFixed(2).replace(/0$/, '')}</span>
          <small>STREAK {comboPulse.streak}</small>
        </div>
      )}

      {status === 'over' && (
        <div className="status-layer game-over-layer" role="dialog" aria-modal="true" aria-labelledby="game-over-title" data-testid="status-game-over">
          <section className="game-over-card">
            <div className="collapse-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none"><path d="M12 7v6m0 4h.01M4.9 19h14.2a1.2 1.2 0 0 0 1.04-1.8L13.04 4.8a1.2 1.2 0 0 0-2.08 0L3.86 17.2A1.2 1.2 0 0 0 4.9 19Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
            <div className="game-over-kicker">The balance shifted</div>
            <h1 className="game-over-title" id="game-over-title">TOWER<br />COLLAPSED!</h1>
            <p className="game-over-copy">A new run is one move away. Take your best placement into the next tower.</p>
            <div className="run-stats" aria-label="Final run statistics">
              <div className="run-stat-row">
                <span>Final height reached</span>
                <strong data-testid="text-final-height">{(finalRunStats?.height ?? height).toFixed(1)}<small>m</small></strong>
              </div>
              <div className="run-stat-row">
                <span>Total blocks stacked</span>
                <strong data-testid="text-final-score">{finalRunStats?.score ?? score}</strong>
              </div>
              <div className="run-stat-row">
                <span>Bonus points earned</span>
                <strong data-testid="text-final-points">{(finalRunStats?.points ?? points).toLocaleString()}</strong>
              </div>
              <div className="run-stat-row">
                <span>Best streak</span>
                <strong data-testid="text-final-streak">{finalRunStats?.streak ?? streak}</strong>
              </div>
              <div className="run-stat-row best-stat-row">
                <span>Personal best</span>
                <strong data-testid="text-high-score">{finalRunStats?.bestScore ?? bestScore}</strong>
                {finalRunStats?.newHighScore && <span className="new-record-badge" data-testid="badge-new-high-score">NEW HIGH SCORE</span>}
              </div>
            </div>
            <div className="game-over-actions">
              <button className="retry-button" onClick={restart} data-testid="button-play-again">
                <RestartIcon /> TRY AGAIN
              </button>
              <div className="secondary-actions">
                <button className="menu-action-button" onClick={openMainMenu} data-testid="button-main-menu">MAIN MENU</button>
                <button className="share-action-button" onClick={shareScore} data-testid="button-share-score">
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M12.5 6.1 7.7 8.7m4.8 5.2-4.8-2.6M15 5.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM5 11.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Zm10 5.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  SHARE SCORE
                </button>
              </div>
              {shareMessage && <p className="share-feedback" role="status" data-testid="text-share-feedback">{shareMessage}</p>}
            </div>
          </section>
        </div>
      )}

      {showMenu && status !== 'error' && (
        <div className={`home-menu-layer ${menuExiting ? 'is-exiting' : ''}`} aria-label="Stacker home screen" data-testid="status-main-menu">
          <div className="home-visual" aria-hidden="true">
            <div className="home-visual-grid" />
            <div className="home-orbit home-orbit-one" />
            <div className="home-orbit home-orbit-two" />
            <div className="home-tower-stage">
              <div className="home-tower-stack">
                <div className="tower-slice slice-one" />
                <div className="tower-slice slice-two" />
                <div className="tower-slice slice-three" />
                <div className="tower-slice slice-four" />
                <div className="tower-slice slice-five" />
                <div className="tower-slice slice-six" />
                <div className="tower-slice slice-seven" />
              </div>
              <div className="home-tower-shadow" />
            </div>
          </div>
          <button className="home-leaderboard-link" onClick={openLeaderboard} data-testid="button-leaderboard">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 16V9m6 7V4m6 12v-5M2 16.5h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>LEADERBOARD</span>
          </button>
          <button className="home-settings-link" onClick={() => openSettings('home')} data-testid="button-home-settings">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8.2 2.6h3.6l.5 1.8 1.3.8 1.8-.4 1.8 3.1-1.3 1.4v1.5l1.3 1.4-1.8 3.1-1.8-.4-1.3.8-.5 1.8H8.2l-.5-1.8-1.3-.8-1.8.4-1.8-3.1 1.3-1.4v-1.5L2.8 8l1.8-3.1 1.8.4 1.3-.8.5-1.9Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><circle cx="10" cy="10.1" r="2.4" stroke="currentColor" strokeWidth="1.2"/></svg>
            <span>SETTINGS</span>
          </button>
          <section className="home-menu-content">
            <div className="home-menu-mark"><StackerMark /></div>
            <div className="home-menu-eyebrow"><span /> THE PHYSICS STACKING GAME <span /></div>
            <h1 id="home-menu-title">STACK-A-TOWER<span>: PHYSICS</span></h1>
            <p className="home-menu-subtitle">The ultimate minimalist stacking challenge.</p>
            <div className="home-menu-actions">
              <button className="home-start-button" onClick={startFromMenu} disabled={status !== 'ready' || menuExiting} data-testid="button-start-game">
                <span>{status === 'ready' ? 'START GAME' : 'LOADING GAME'}</span>
                <ArrowIcon />
              </button>
              <button className="home-howto-button" onClick={openHowToPlay} disabled={menuExiting} data-testid="button-how-to-play">HOW TO PLAY</button>
            </div>
            <div className="home-begin-hint">
              <span className="home-pulse-dot" />
              <span>{status === 'ready' ? 'TAP TO BEGIN' : 'SETTING UP THE PHYSICS'}</span>
            </div>
            <div className="home-record-note">PERSONAL BEST <strong>{bestScore}</strong> BLOCKS</div>
          </section>
          {(howToPlayOpen || leaderboardOpen) && (
            <div className="home-detail-layer" onClick={closeHomeModal}>
              <section className="home-detail-card" role="dialog" aria-modal="true" aria-labelledby="home-detail-title" onClick={(event) => event.stopPropagation()}>
                <button className="home-modal-close" onClick={closeHomeModal} aria-label="Close dialog">×</button>
                {howToPlayOpen ? (
                  <>
                    <div className="home-detail-eyebrow">QUICK GUIDE</div>
                    <h2 id="home-detail-title">How to play</h2>
                    <p>Build upward without losing your balance. Every block adds weight and a new challenge.</p>
                    <div className="home-guide-list">
                      <div><span className="guide-key">CLICK / TAP</span><span>Drop the next block</span></div>
                      <div><span className="guide-key">← → · A / D</span><span>Adjust its landing position</span></div>
                      <div><span className="guide-key">↑ · R</span><span>Rotate the next shape</span></div>
                      <div><span className="guide-key">PAUSE</span><span>Take a break between drops</span></div>
                    </div>
                    <button className="home-modal-primary" onClick={closeHomeModal}>GOT IT</button>
                  </>
                ) : (
                  <>
                    <div className="home-detail-eyebrow">THIS DEVICE</div>
                    <h2 id="home-detail-title">Leaderboard</h2>
                    <p>Your best run, saved locally in this browser.</p>
                    <div className="home-leader-row"><span><b>01</b> YOUR PERSONAL BEST</span><strong>{bestScore}<small> blocks</small></strong></div>
                    <div className="home-leader-row"><span><b>↗</b> BEST TOWER HEIGHT</span><strong>{bestHeight.toFixed(1)}<small> m</small></strong></div>
                    <button className="home-modal-primary" onClick={closeHomeModal}>CLOSE</button>
                  </>
                )}
              </section>
            </div>
          )}
        </div>
      )}

      {settingsOpen && (
        <div className={`settings-backdrop ${settingsClosing ? 'is-closing' : ''}`} role="presentation" onClick={closeSettings} data-testid="settings-backdrop">
          <section className="settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
            <header className="settings-header">
              <div className="settings-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none"><path d="M9.6 3h4.8l.6 2.2 1.6.9 2.1-.5 2.4 4.1-1.5 1.7v1.8l1.5 1.7-2.4 4.1-2.1-.5-1.6.9-.6 2.2H9.6L9 19.4l-1.6-.9-2.1.5-2.4-4.1 1.5-1.7v-1.8l-1.5-1.7 2.4-4.1 2.1.5L9 5.2 9.6 3Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round"/><circle cx="12" cy="12.3" r="3" stroke="currentColor" strokeWidth="1.35"/></svg>
              </div>
              <div>
                <div className="settings-eyebrow">STACKER PREFERENCES</div>
                <h2 id="settings-title">Settings</h2>
              </div>
              <button className="settings-close-icon" onClick={closeSettings} aria-label="Close settings">×</button>
            </header>

            <div className="settings-section">
              <div className="settings-section-title"><span>01</span> AUDIO</div>
              <div className="settings-row">
                <div><strong>Sound effects</strong><small>Block drops and landings</small></div>
                <button
                  className={`settings-switch ${settings.soundEffects ? 'is-on' : ''}`}
                  role="switch"
                  aria-checked={settings.soundEffects}
                  aria-label="Sound effects"
                  onClick={() => updateSettings({ soundEffects: !settings.soundEffects })}
                  data-testid="toggle-sfx"
                ><span /></button>
              </div>
              <div className="settings-row">
                <div><strong>Background music</strong><small>Soft ambient game tone</small></div>
                <button
                  className={`settings-switch ${settings.backgroundMusic ? 'is-on' : ''}`}
                  role="switch"
                  aria-checked={settings.backgroundMusic}
                  aria-label="Background music"
                  onClick={() => updateSettings({ backgroundMusic: !settings.backgroundMusic })}
                  data-testid="toggle-music"
                ><span /></button>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title"><span>02</span> GRAPHICS</div>
              <div className="settings-quality-row">
                <div><strong>Graphics quality</strong><small>Balance detail and performance</small></div>
                <label className="settings-select-wrap">
                  <select
                    value={settings.graphicsQuality}
                    onChange={(event) => updateSettings({ graphicsQuality: event.target.value as GraphicsQuality })}
                    aria-label="Graphics quality"
                    data-testid="select-graphics-quality"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                  <span aria-hidden="true">⌄</span>
                </label>
              </div>
              <p className="settings-note">Shadows and render scale update now. Anti-aliasing uses this choice after the next page load.</p>
              <div className="settings-quality-row settings-camera-row">
                <div><strong>Camera distance</strong><small>Choose a closer or wider view</small></div>
                <label className="settings-select-wrap">
                  <select
                    value={settings.cameraDistance}
                    onChange={(event) => updateSettings({ cameraDistance: event.target.value as CameraDistancePreference })}
                    aria-label="Camera distance"
                    data-testid="select-camera-distance"
                  >
                    <option value="close">Closer</option>
                    <option value="standard">Standard</option>
                    <option value="wide">Wider</option>
                  </select>
                  <span aria-hidden="true">⌄</span>
                </label>
              </div>
              <p className="settings-note">Auto-fit pulls back when needed to keep the tower and active block visible.</p>
            </div>

            <div className="settings-section settings-controls-section">
              <div className="settings-section-title"><span>03</span> CONTROLS</div>
              <div className="settings-mode-heading">
                <strong>Control mode</strong>
                <small>Choose how to place blocks</small>
              </div>
              <div className="settings-mode-selector" role="group" aria-label="Control mode">
                <button
                  className={settings.controlMode === 'tap' ? 'is-selected' : ''}
                  onClick={() => updateSettings({ controlMode: 'tap' })}
                  aria-pressed={settings.controlMode === 'tap'}
                  data-testid="control-mode-tap"
                >Tap / Click</button>
                <button
                  className={settings.controlMode === 'keyboard' ? 'is-selected' : ''}
                  onClick={() => updateSettings({ controlMode: 'keyboard' })}
                  aria-pressed={settings.controlMode === 'keyboard'}
                  data-testid="control-mode-keyboard"
                >Keyboard</button>
              </div>
            </div>

            {resetConfirmOpen ? (
              <div className="reset-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="reset-confirm-title">
                <strong id="reset-confirm-title">Clear saved progress?</strong>
                <p>This removes the saved best score and height and restarts the current tower. Your settings stay unchanged.</p>
                <div>
                  <button className="reset-cancel-button" onClick={() => setResetConfirmOpen(false)}>KEEP PROGRESS</button>
                  <button className="reset-confirm-button" onClick={resetProgress} data-testid="button-confirm-reset">CLEAR PROGRESS</button>
                </div>
              </div>
            ) : (
              <div className="settings-footer">
                <button className="reset-progress-button" onClick={() => setResetConfirmOpen(true)} data-testid="button-reset-progress">Reset progress</button>
                <button className="settings-save-button" onClick={closeSettings} data-testid="button-save-settings">
                  {settingsReturnTo === 'pause' ? 'BACK TO PAUSE' : 'SAVE & CLOSE'}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
