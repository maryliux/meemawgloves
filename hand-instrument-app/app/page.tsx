"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as Tone from "tone";

interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

interface HandResults {
  multiHandLandmarks?: HandLandmark[][];
}

interface MediaPipeHands {
  setOptions: (options: {
    maxNumHands: number;
    modelComplexity: number;
    minDetectionConfidence: number;
    minTrackingConfidence: number;
  }) => void;
  onResults: (callback: (results: HandResults) => void) => void;
  send: (input: { image: HTMLVideoElement }) => Promise<void>;
}

const GRID_SIZE = 10;
const MIN_STAR_SIZE = 1;
const MAX_STAR_SIZE = 3;
const CAMERA_REQUEST_TIMEOUT_MS = 10000;
const VIDEO_READY_TIMEOUT_MS = 10000;
const MEDIAPIPE_SCRIPT_TIMEOUT_MS = 10000;

// Fingertip landmark indices
const FINGERTIP_INDICES = [4, 8, 12, 16, 20];
const WRIST_INDEX = 0;

interface PointerState {
  x: number;
  y: number;
  active: boolean;
}

function timeoutReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error(message)), ms);
  });
}

async function loadMediaPipeHandsConstructor(): Promise<
  new (config: { locateFile: (file: string) => string }) => MediaPipeHands
> {
  const existingHands = (window as unknown as {
    Hands?: new (config: { locateFile: (file: string) => string }) => MediaPipeHands;
  }).Hands;

  if (existingHands) {
    return existingHands;
  }

  const existingScript = document.querySelector<HTMLScriptElement>('script[data-mediapipe="hands"]');

  return new Promise((resolve, reject) => {
    const script = existingScript ?? document.createElement("script");

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };

    const onLoad = () => {
      cleanup();
      const Hands = (window as unknown as {
        Hands?: new (config: { locateFile: (file: string) => string }) => MediaPipeHands;
      }).Hands;
      if (!Hands) {
        reject(new Error("MediaPipe Hands loaded but constructor is unavailable."));
        return;
      }
      resolve(Hands);
    };

    const onError = () => {
      cleanup();
      reject(new Error("Failed to load MediaPipe Hands library."));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while loading MediaPipe Hands library."));
    }, MEDIAPIPE_SCRIPT_TIMEOUT_MS);

    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);

    if (!existingScript) {
      script.src = "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js";
      script.dataset.mediapipe = "hands";
      document.head.appendChild(script);
    }
  });
}

// Draw a star shape
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, points: number) {
  const outerRadius = size;
  const innerRadius = size * 0.4;
  
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fill();
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handsRef = useRef<MediaPipeHands | null>(null);
  const animationRef = useRef<number>(0);
  const oscillatorRef = useRef<Tone.Oscillator | null>(null);
  const gainNodeRef = useRef<Tone.Gain | null>(null);
  const landmarksRef = useRef<HandLandmark[] | null>(null);
  const mediaReadyRef = useRef(false);

  const [audioStarted, setAudioStarted] = useState(false);
  const [currentHz, setCurrentHz] = useState(0);
  const [currentVolume, setCurrentVolume] = useState(0);
  const [cameraStarted, setCameraStarted] = useState(false);
  const [permissionError, setPermissionError] = useState(false);
  const [cursorMode, setCursorMode] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const pointerRef = useRef<PointerState>({ x: 0.5, y: 0.5, active: false });

  const ensureAudio = useCallback(async () => {
    if (oscillatorRef.current && gainNodeRef.current) {
      return;
    }

    await Tone.start();
    const gain = new Tone.Gain(0).toDestination();
    const osc = new Tone.Oscillator(200, "sine").connect(gain);
    osc.start();
    oscillatorRef.current = osc;
    gainNodeRef.current = gain;
    setAudioStarted(true);
  }, []);

  const stopCameraStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
    videoRef.current = null;
    mediaReadyRef.current = false;
    landmarksRef.current = null;
    handsRef.current = null;
  }, []);

  const drawHalftone = useCallback((ctx: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number) => {
    // Check if video is ready
    if (video.readyState < 2) return;
    
    // Draw video to offscreen canvas to sample pixels (no mirroring - natural view)
    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    const offCtx = offscreen.getContext("2d")!;
    offCtx.drawImage(video, 0, 0, width, height);
    
    const imageData = offCtx.getImageData(0, 0, width, height);
    const pixels = imageData.data;

    // Dark background with white stars
    ctx.fillStyle = "#0a0a12";
    ctx.fillRect(0, 0, width, height);

    // Draw halftone as white stars on dark background
    ctx.fillStyle = "#ffffff";
    
    for (let y = GRID_SIZE / 2; y < height; y += GRID_SIZE) {
      for (let x = GRID_SIZE / 2; x < width; x += GRID_SIZE) {
        const i = (Math.floor(y) * width + Math.floor(x)) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        
        // Calculate brightness (0-255)
        const brightness = (r + g + b) / 3;
        
        // Map brightness to star size: bright = big star, dark = small/no star
        const normalizedBrightness = brightness / 255;
        const size = MIN_STAR_SIZE + (MAX_STAR_SIZE - MIN_STAR_SIZE) * normalizedBrightness;
        
        if (normalizedBrightness > 0.15) {
          // Vary star points based on size for visual interest
          const points = size > 5 ? 6 : (size > 3 ? 5 : 4);
          drawStar(ctx, x, y, size, points);
        }
      }
    }
  }, []);

  const drawLandmarks = useCallback((ctx: CanvasRenderingContext2D, landmarks: HandLandmark[], width: number, height: number) => {
    // Brighter accent color for hand tracking
    ctx.fillStyle = "#ff2d55";
    
    for (const landmark of landmarks) {
      // Direct mapping - no mirroring
      const x = landmark.x * width;
      const y = landmark.y * height;
      
      // Draw larger stars for landmarks
      drawStar(ctx, x, y, 8, 6);
    }
    
    // Draw connections between landmarks for better visibility
    ctx.strokeStyle = "#ff2d55";
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    
    // Finger connections
    const connections = [
      [0, 1], [1, 2], [2, 3], [3, 4], // thumb
      [0, 5], [5, 6], [6, 7], [7, 8], // index
      [0, 9], [9, 10], [10, 11], [11, 12], // middle
      [0, 13], [13, 14], [14, 15], [15, 16], // ring
      [0, 17], [17, 18], [18, 19], [19, 20], // pinky
      [5, 9], [9, 13], [13, 17] // palm
    ];
    
    for (const [start, end] of connections) {
      const s = landmarks[start];
      const e = landmarks[end];
      ctx.beginPath();
      ctx.moveTo(s.x * width, s.y * height);
      ctx.lineTo(e.x * width, e.y * height);
      ctx.stroke();
    }
    
    ctx.globalAlpha = 1;
  }, []);

  const updateAudio = useCallback((landmarks: HandLandmark[]) => {
    if (!oscillatorRef.current || !gainNodeRef.current) return;

    const wrist = landmarks[WRIST_INDEX];
    
    // Map wrist Y to frequency (80-600Hz)
    const normalizedY = 1 - wrist.y;
    const frequency = 80 + normalizedY * 520;
    
    // Calculate average fingertip-to-wrist distance
    let totalDistance = 0;
    for (const idx of FINGERTIP_INDICES) {
      const tip = landmarks[idx];
      const dx = tip.x - wrist.x;
      const dy = tip.y - wrist.y;
      totalDistance += Math.sqrt(dx * dx + dy * dy);
    }
    const avgDistance = totalDistance / FINGERTIP_INDICES.length;
    
    // Map distance to gain
    const normalizedGain = Math.min(1, Math.max(0, (avgDistance - 0.05) / 0.2));
    
    oscillatorRef.current.frequency.rampTo(frequency, 0.1);
    gainNodeRef.current.gain.rampTo(normalizedGain * 0.5, 0.1);
    
    setCurrentHz(Math.round(frequency));
    setCurrentVolume(Math.round(normalizedGain * 100));
  }, []);

  const updateAudioFromPointer = useCallback((pointer: PointerState) => {
    if (!oscillatorRef.current || !gainNodeRef.current) return;

    const normalizedY = 1 - pointer.y;
    const frequency = 80 + normalizedY * 520;
    const centerDistance = Math.sqrt((pointer.x - 0.5) ** 2 + (pointer.y - 0.5) ** 2);
    const normalizedGain = pointer.active ? Math.min(1, centerDistance * 2.2) : 0.1;

    oscillatorRef.current.frequency.rampTo(frequency, 0.08);
    gainNodeRef.current.gain.rampTo(normalizedGain * 0.5, 0.08);

    setCurrentHz(Math.round(frequency));
    setCurrentVolume(Math.round(normalizedGain * 100));
  }, []);

  const onResults = useCallback((results: HandResults) => {
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      landmarksRef.current = results.multiHandLandmarks[0];
      updateAudio(results.multiHandLandmarks[0]);
    } else {
      landmarksRef.current = null;
      if (gainNodeRef.current) {
        gainNodeRef.current.gain.rampTo(0, 0.3);
      }
      setCurrentVolume(0);
    }
  }, [updateAudio]);

  const startCursorMode = useCallback(async (message = "Running Cursor Mode (mouse/touch controlled)") => {
    await ensureAudio();
    stopCameraStream();
    setPermissionError(false);
    setCursorMode(true);
    setCameraStarted(false);
    setStatusMessage(message);

    cancelAnimationFrame(animationRef.current);

    const renderCursorMode = (time: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        animationRef.current = requestAnimationFrame(renderCursorMode);
        return;
      }

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      const pointer = pointerRef.current;
      updateAudioFromPointer(pointer);

      ctx.fillStyle = "#0a0a12";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";

      const pointerX = pointer.x * canvas.width;
      const pointerY = pointer.y * canvas.height;

      for (let y = GRID_SIZE; y < canvas.height; y += GRID_SIZE) {
        for (let x = GRID_SIZE; x < canvas.width; x += GRID_SIZE) {
          const dx = x - pointerX;
          const dy = y - pointerY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const wave = (Math.sin(distance * 0.06 - time * 0.004) + 1) * 0.5;
          const pulse = pointer.active ? 1 : 0.5;
          const intensity = wave * pulse;
          if (intensity > 0.42) {
            const size = MIN_STAR_SIZE + intensity * (MAX_STAR_SIZE + 2);
            drawStar(ctx, x, y, size, 5);
          }
        }
      }

      if (pointer.active) {
        ctx.fillStyle = "#ff2d55";
        drawStar(ctx, pointerX, pointerY, 12, 6);
      }

      animationRef.current = requestAnimationFrame(renderCursorMode);
    };

    animationRef.current = requestAnimationFrame(renderCursorMode);
  }, [ensureAudio, stopCameraStream, updateAudioFromPointer]);

  const startExperience = async () => {
    if (isStarting) return;

    setIsStarting(true);
    setStatusMessage("Starting webcam mode...");
    setPermissionError(false);
    setCursorMode(false);

    try {
      await ensureAudio();
      stopCameraStream();

      // Request webcam
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user",
            frameRate: { ideal: 30 },
          },
        }),
        timeoutReject(
          CAMERA_REQUEST_TIMEOUT_MS,
          "Camera request timed out in this environment. Falling back to Cursor Mode."
        ),
      ]);

      streamRef.current = stream;

      // Create and setup video element
      const video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;

      // Wait for video to be ready
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => {
            video.play().then(() => {
              mediaReadyRef.current = true;
              resolve();
            }).catch(reject);
          };
          video.onerror = () => reject(new Error("Failed to initialize webcam video stream."));
        }),
        timeoutReject(
          VIDEO_READY_TIMEOUT_MS,
          "Webcam stream started but video never became ready. Falling back to Cursor Mode."
        ),
      ]);

      videoRef.current = video;

      // Load MediaPipe Hands from CDN
      const Hands = await loadMediaPipeHandsConstructor();

      const hands = new Hands({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });

      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.5,
      });

      hands.onResults(onResults);
      handsRef.current = hands;
      setCursorMode(false);
      setCameraStarted(true);
      setStatusMessage("Webcam mode live");

      // Render loop with proper frame timing
      let lastFrameTime = 0;
      const targetFrameTime = 1000 / 30; // 30fps

      cancelAnimationFrame(animationRef.current);

      const render = async (currentTime: number) => {
        if (currentTime - lastFrameTime >= targetFrameTime) {
          lastFrameTime = currentTime;

          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          const liveVideo = videoRef.current;

          if (canvas && ctx && liveVideo && mediaReadyRef.current && liveVideo.readyState >= 2) {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;

            // Send frame to MediaPipe
            if (handsRef.current) {
              try {
                await handsRef.current.send({ image: liveVideo });
              } catch (_e) {
                // Ignore send errors
              }
            }

            // Draw halftone effect
            drawHalftone(ctx, liveVideo, canvas.width, canvas.height);

            // Draw landmarks on top
            if (landmarksRef.current) {
              drawLandmarks(ctx, landmarksRef.current, canvas.width, canvas.height);
            }
          }
        }

        animationRef.current = requestAnimationFrame(render);
      };

      animationRef.current = requestAnimationFrame(render);
    } catch (err) {
      console.error("[cursor] Webcam mode failed, switching to Cursor Mode:", err);
      try {
        await startCursorMode("Camera unavailable here. Running Cursor Mode (mouse/touch).");
      } catch (fallbackErr) {
        console.error("[cursor] Cursor Mode fallback failed:", fallbackErr);
        setPermissionError(true);
      }
    } finally {
      setIsStarting(false);
    }
  };

  const startCursorModeFromButton = async () => {
    if (isStarting) return;
    setIsStarting(true);
    try {
      await startCursorMode();
    } catch (err) {
      console.error("[cursor] Failed to start Cursor Mode:", err);
      setPermissionError(true);
    } finally {
      setIsStarting(false);
    }
  };

  useEffect(() => {
    if (!cursorMode) return;

    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = {
        x: event.clientX / window.innerWidth,
        y: event.clientY / window.innerHeight,
        active: true,
      };
    };

    const onPointerLeave = () => {
      pointerRef.current = { ...pointerRef.current, active: false };
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerdown", onPointerMove);
    window.addEventListener("pointerup", onPointerLeave);
    window.addEventListener("pointerleave", onPointerLeave);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerMove);
      window.removeEventListener("pointerup", onPointerLeave);
      window.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [cursorMode]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animationRef.current);
      oscillatorRef.current?.stop();
      oscillatorRef.current?.dispose();
      gainNodeRef.current?.dispose();
      stopCameraStream();
    };
  }, [stopCameraStream]);

  return (
    <>
      <canvas ref={canvasRef} className="fixed inset-0 w-full h-full bg-[#0a0a12]" />

      {(cameraStarted || cursorMode) && (
        <div className="fixed top-4 left-4 font-mono text-xs text-white/70 bg-black/50 px-2 py-1 rounded">
          <div>{cursorMode ? "Cursor Mode" : "Webcam Mode"}</div>
          <div>{currentHz} Hz</div>
          <div>{currentVolume}% vol</div>
        </div>
      )}

      {cursorMode && (
        <div className="fixed top-4 right-4 font-mono text-xs text-white/70 bg-black/50 px-3 py-2 rounded max-w-xs text-right">
          <div>{statusMessage}</div>
          <div className="mt-1 text-white/50">Move pointer to control pitch + volume</div>
          <button
            onClick={startExperience}
            disabled={isStarting}
            className="mt-2 px-3 py-1 bg-white/10 hover:bg-white/20 disabled:opacity-50 rounded text-white"
          >
            {isStarting ? "Starting..." : "Try Webcam Again"}
          </button>
        </div>
      )}

      {!audioStarted && !permissionError && !cursorMode && (
        <div className="fixed inset-0 bg-[#0a0a12] flex flex-col items-center justify-center gap-4">
          <div className="text-white/60 text-sm font-mono mb-2">Hand Instrument</div>
          <button
            onClick={startExperience}
            disabled={isStarting}
            className="px-6 py-3 bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white font-mono text-sm rounded transition-colors"
          >
            {isStarting ? "Starting..." : "Enable Webcam"}
          </button>
          <button
            onClick={startCursorModeFromButton}
            disabled={isStarting}
            className="px-6 py-3 bg-white/5 hover:bg-white/15 disabled:opacity-50 text-white/90 font-mono text-sm rounded transition-colors"
          >
            Start Cursor Mode
          </button>
          <div className="text-white/40 text-xs font-mono mt-2">Webcam on supported browsers, Cursor Mode everywhere</div>
        </div>
      )}

      {permissionError && (
        <div className="fixed inset-0 bg-[#0a0a12] flex flex-col items-center justify-center gap-4 p-8">
          <div className="text-red-400 text-sm font-mono mb-2">Startup Failed</div>
          <div className="text-white/60 text-xs font-mono text-center max-w-md leading-relaxed">
            Unable to start webcam mode in this preview.
          </div>
          <button
            onClick={startCursorModeFromButton}
            className="mt-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white font-mono text-xs rounded transition-colors"
          >
            Start Cursor Mode
          </button>
          <button
            onClick={startExperience}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white font-mono text-xs rounded transition-colors"
          >
            Try Webcam Again
          </button>
        </div>
      )}
    </>
  );
}
