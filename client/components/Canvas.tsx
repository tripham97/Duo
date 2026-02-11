"use client";

import { useEffect, useRef } from "react";
import { socket } from "@/lib/socket";

export default function Canvas({ roomId, isDrawer, color, brushSize = 3 }: any) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  function drawSegment(ctx: CanvasRenderingContext2D, stroke: any) {
    ctx.strokeStyle = stroke.color || "#ffffff";
    ctx.lineWidth = stroke.width || 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(stroke.x0, stroke.y0);
    ctx.lineTo(stroke.x1, stroke.y1);
    ctx.stroke();
  }

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    // 🔥 FULLSCREEN CANVAS
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const onDraw = (stroke: any) => drawSegment(ctx, stroke);
    const onCanvasState = ({ strokes }: { strokes: any[] }) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      (strokes || []).forEach((stroke) => drawSegment(ctx, stroke));
    };

    const onClear = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    socket.on("DRAW", onDraw);
    socket.on("CANVAS_STATE", onCanvasState);
    window.addEventListener("clearCanvas", onClear);

    return () => {
      socket.off("DRAW", onDraw);
      socket.off("CANVAS_STATE", onCanvasState);
      window.removeEventListener("clearCanvas", onClear);
      window.removeEventListener("resize", resize);
    };
  }, []);

  function onMove(e: MouseEvent) {
    if (!drawing.current || !isDrawer) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const stroke = {
      x0: last.current.x,
      y0: last.current.y,
      x1: x,
      y1: y,
      color,
      width: brushSize
    };

    const ctx = canvasRef.current!.getContext("2d")!;
    drawSegment(ctx, stroke);

    socket.emit("DRAW", {
      roomId,
      stroke
    });

    last.current = { x, y };
  }

  return (
    <canvas
      ref={canvasRef}
      className="canvas-full"
      onMouseDown={(e) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        drawing.current = true;
        last.current = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top
        };
      }}
      onMouseUp={() => (drawing.current = false)}
      onMouseMove={(e) => onMove(e.nativeEvent)}
    />
  );
}
