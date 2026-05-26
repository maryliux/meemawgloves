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
const MEDIAPIPE_SCRIPT_ID = "mediapipe-hands-script";
const MEDIAPIPE_SCRIPT_SRC = "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js";
const SCRIPT_LOAD_TIMEOUT_MS = 10000;

// Fingertip landmark indices
const FINGERTIP_INDICES = [4, 8, 12, 16, 20];
const WRIST_INDEX = 0;

function getStartupErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "Camera access was blocked by your browser or preview permissions.";
    }
    if (error.name === "NotFoundError") {
      return "No camera was found on this device.";
    }
    if (error.name === "NotReadableError") {
      return "Camera is currently busy in another app or tab.";
    }
  }

  if (error instanceof Error) {
    if (error.message.includes("secure context")) {
      return "Camera access requires a secure context (HTTPS or localhost).";
    }
    return error.message;
  }

  return "Unable to initialize camera and hand tracking.";
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
  const [isStarting, setIsStarting] = useState(false);
  const [startupErrorMessage, setStartupErrorMessage] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const loadMediaPipeScript = useCallback(async () => {
    if ((window as unknown as { Hands?: unknown }).Hands) {
      return;
    }

    const existingScript = document.getElementById(MEDIAPIPE_SCRIPT_ID) as HTMLScriptElement | null;

    await new Promise<void>((resolve, reject) => {
      const script = existingScript ?? document.createElement("script");

      const onLoad = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error("Hand tracking library failed to load in this preview."));
      };

      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while loading hand tracking library."));
      }, SCRIPT_LOAD_TIMEOUT_MS);

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        script.removeEventListener("load", onLoad);
        script.removeEventListener("error", onError);
      };

      script.addEventListener("load", onLoad);
      script.addEventListener("error", onError);

      if (!existingScript) {
        script.id = MEDIAPIPE_SCRIPT_ID;
        script.src = MEDIAPIPE_SCRIPT_SRC;
        document.head.appendChild(script);
      }
    });
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

  const startExperience = async () => {
    if (isStarting || cameraStarted) return;

    setIsStarting(true);
    setPermissionError(false);
    setStartupErrorMessage(null);

    try {
      if (!window.isSecureContext) {
        throw new Error("Camera access requires a secure context.");
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera API is unavailable in this preview context.");
      }

      // Hide entry screen immediately so repeated clicks do not stack startup attempts.
      setAudioStarted(true);

      // Start audio first, but do not block camera startup on audio failures.
      try {
        await Tone.start();

        const gain = new Tone.Gain(0).toDestination();
        const osc = new Tone.Oscillator(200, "sine").connect(gain);
        osc.start();

        oscillatorRef.current = osc;
        gainNodeRef.current = gain;
      } catch (audioErr) {
        console.warn("[v0] Audio could not be initialized:", audioErr);
      }

      // Request webcam
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          width: { ideal: 1280 }, 
          height: { ideal: 720 }, 
          facingMode: "user",
          frameRate: { ideal: 30 }
        }
      });
      
      streamRef.current = stream;

      // Create and setup video element
      const video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      
      // Wait for video to be ready
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => {
          video.play().then(() => {
            mediaReadyRef.current = true;
            resolve();
          });
        };
      });
      
      videoRef.current = video;

      // Load MediaPipe Hands from CDN
      await loadMediaPipeScript();
      const Hands = (window as unknown as {
        Hands?: new (config: { locateFile: (file: string) => string }) => MediaPipeHands;
      }).Hands;

      if (!Hands) {
        throw new Error("Hand tracking did not initialize after library load.");
      }

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
      setCameraStarted(true);

      // Render loop with proper frame timing
      let lastFrameTime = 0;
      const targetFrameTime = 1000 / 30; // 30fps

      cancelAnimationFrame(animationRef.current);

      const render = async (currentTime: number) => {
        if (currentTime - lastFrameTime >= targetFrameTime) {
          lastFrameTime = currentTime;

          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          const video = videoRef.current;

          if (canvas && ctx && video && mediaReadyRef.current && video.readyState >= 2) {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;

            // Send frame to MediaPipe
            if (handsRef.current) {
              try {
                await handsRef.current.send({ image: video });
              } catch (_e) {
                // Ignore per-frame send errors and continue rendering.
              }
            }

            // Draw halftone effect
            drawHalftone(ctx, video, canvas.width, canvas.height);

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
      console.error("[v0] Error starting experience:", err);
      setPermissionError(true);
      setStartupErrorMessage(getStartupErrorMessage(err));
      setAudioStarted(false);
      setCameraStarted(false);
      setCurrentHz(0);
      setCurrentVolume(0);
      oscillatorRef.current?.stop();
      oscillatorRef.current?.dispose();
      gainNodeRef.current?.dispose();
      oscillatorRef.current = null;
      gainNodeRef.current = null;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      streamRef.current = null;
      mediaReadyRef.current = false;
      landmarksRef.current = null;
    } finally {
      setIsStarting(false);
    }
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animationRef.current);
      oscillatorRef.current?.stop();
      oscillatorRef.current?.dispose();
      gainNodeRef.current?.dispose();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="fixed inset-0 w-full h-full bg-[#0a0a12]" />
      
      {cameraStarted && (
        <div className="fixed top-4 left-4 font-mono text-xs text-white/70 bg-black/50 px-2 py-1 rounded">
          <div>{currentHz} Hz</div>
          <div>{currentVolume}% vol</div>
        </div>
      )}
      
      {!audioStarted && !permissionError && (
        <div className="fixed inset-0 bg-[#0a0a12] flex flex-col items-center justify-center gap-6">
          <div className="text-white/60 text-sm font-mono mb-2">Hand Instrument</div>
          <button
            onClick={startExperience}
            disabled={isStarting}
            className="px-6 py-3 bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed text-white font-mono text-sm rounded transition-colors"
          >
            {isStarting ? "Starting..." : "Enable Webcam"}
          </button>
          <div className="text-white/40 text-xs font-mono mt-2">Requires camera and audio access</div>
        </div>
      )}
      
      {permissionError && (
        <div className="fixed inset-0 bg-[#0a0a12] flex flex-col items-center justify-center gap-4 p-8">
          <div className="text-red-400 text-sm font-mono mb-2">Camera Access Blocked</div>
          <div className="text-white/60 text-xs font-mono text-center max-w-md leading-relaxed">
            {startupErrorMessage ?? "Camera access is blocked in this preview."}
          </div>
          <div className="text-white/50 text-xs font-mono text-center max-w-md leading-relaxed">
            To use this app:
          </div>
          <ol className="text-white/50 text-xs font-mono text-left list-decimal list-inside space-y-2 mt-2">
            <li>Click the &quot;Open in new tab&quot; button (top right of preview)</li>
            <li>Or deploy the app using the &quot;Publish&quot; button</li>
            <li>Allow camera access when prompted by your browser</li>
          </ol>
          <button
            onClick={() => window.open(window.location.href, "_blank", "noopener,noreferrer")}
            className="mt-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white font-mono text-xs rounded transition-colors"
          >
            Open in New Tab
          </button>
          <button
            onClick={() => {
              setPermissionError(false);
              setAudioStarted(false);
              setStartupErrorMessage(null);
            }}
            className="mt-4 px-4 py-2 bg-white/10 hover:bg-white/20 text-white font-mono text-xs rounded transition-colors"
          >
            Try Again
          </button>
        </div>
      )}
    </>
  );
}
