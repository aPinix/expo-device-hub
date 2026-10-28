import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { DeviceClient } from "@expo/hub-client";
import {
  Button,
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogContentContainer,
  DialogFooter,
  bg,
  border,
  radius,
  text,
  textSize,
} from "../primitives";
import type { Device } from "./data";

type Point = { x: number; y: number };
type Region = { x: number; y: number; width: number; height: number };

/** Freeze first, so selecting a region never sends touches to the phone. */
export function ScreenshotAnnotation({
  client,
  device,
  open,
  onClose,
}: {
  client: DeviceClient;
  device: Device;
  open: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [region, setRegion] = useState<Region | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const start = useRef<Point | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const capture = useRef(client.screenshot);
  capture.current = client.screenshot;

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setNote("");
    setRegion(null);
    setError(null);
    setSaved(false);
    void capture
      .current()
      .then((result) => {
        if (stopped) return;
        if (!result)
          throw new Error("No device frame available. Wait for the preview and try again.");
        objectUrl = URL.createObjectURL(result.blob);
        setUrl(objectUrl);
      })
      .catch((error) => {
        if (!stopped) setError(String(error));
      });
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, device.id]);

  function point(event: PointerEvent<HTMLDivElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  async function save() {
    try {
      const source = image.current;
      if (!source?.naturalWidth) return;
      const canvas = document.createElement("canvas");
      const width = source.naturalWidth;
      const fontSize = Math.max(20, Math.round(width / 40));
      canvas.width = width;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image export is unavailable.");
      context.font = `${fontSize}px sans-serif`;
      const lines: string[] = [];
      for (const paragraph of `${device.name} · ${device.version}\n${note}`.split("\n")) {
        let line = "";
        for (const char of paragraph) {
          if (context.measureText(line + char).width > width - fontSize * 2) {
            lines.push(line);
            line = "";
          }
          line += char;
        }
        lines.push(line);
      }
      canvas.height = source.naturalHeight + (lines.length + 2) * fontSize * 1.4;
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0);
      // Export uses a fixed contrasting annotation ink, independent of the viewer's theme.
      context.strokeStyle = "#ef4444";
      context.lineWidth = Math.max(3, width / 200);
      if (region)
        context.strokeRect(
          region.x * width,
          region.y * source.naturalHeight,
          region.width * width,
          region.height * source.naturalHeight,
        );
      context.fillStyle = "#111111";
      context.font = `${fontSize}px sans-serif`;
      lines.forEach((line, index) =>
        context.fillText(line, fontSize, source.naturalHeight + (index + 1.5) * fontSize * 1.4),
      );
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Could not export the annotation.");
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `${device.name.replace(/[^a-zA-Z0-9_-]/g, "-")}-annotation-${Date.now()}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
      setSaved(true);
    } catch (error) {
      setError(String(error));
    }
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle title={`Annotate ${device.name}`} />
        <DialogContentContainer>
          <p style={{ ...textSize.sm, color: text.secondary }}>
            Drag over the captured screen to mark a region, then add a note.
          </p>
          {!url && !error && <p role="status">Capturing screen…</p>}
          {url && (
            <div
              style={{
                position: "relative",
                width: "fit-content",
                margin: "0 auto",
                touchAction: "none",
                cursor: "crosshair",
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                start.current = point(event);
                setRegion(null);
                setSaved(false);
              }}
              onPointerMove={(event) => {
                if (!start.current) return;
                const end = point(event);
                setRegion({
                  x: Math.min(start.current.x, end.x),
                  y: Math.min(start.current.y, end.y),
                  width: Math.abs(end.x - start.current.x),
                  height: Math.abs(end.y - start.current.y),
                });
              }}
              onPointerUp={() => {
                start.current = null;
              }}
              onPointerCancel={() => {
                start.current = null;
                setRegion(null);
              }}
            >
              <img
                ref={image}
                src={url}
                alt={`Captured ${device.name} screen`}
                draggable={false}
                style={{
                  display: "block",
                  maxHeight: "42vh",
                  maxWidth: "100%",
                  userSelect: "none",
                }}
              />
              {region && (
                <div
                  style={{
                    position: "absolute",
                    pointerEvents: "none",
                    border: `3px solid ${border.danger}`,
                    boxSizing: "border-box",
                    left: `${region.x * 100}%`,
                    top: `${region.y * 100}%`,
                    width: `${region.width * 100}%`,
                    height: `${region.height * 100}%`,
                  }}
                />
              )}
            </div>
          )}
          <label style={{ ...textSize.sm, marginTop: 12 }}>
            Annotation note
            <textarea
              aria-label="Annotation note"
              value={note}
              maxLength={2000}
              rows={3}
              onChange={(event) => {
                setNote(event.target.value);
                setSaved(false);
              }}
              style={{
                display: "block",
                boxSizing: "border-box",
                width: "100%",
                marginTop: 8,
                padding: 12,
                background: bg.default,
                color: text.default,
                border: `1px solid ${border.default}`,
                borderRadius: radius.md,
                ...textSize.sm,
              }}
            />
          </label>
          {error && (
            <p role="alert" style={{ color: text.danger }}>
              {error}
            </p>
          )}
          {saved && (
            <p role="status" style={{ color: text.success }}>
              Annotated screenshot downloaded.
            </p>
          )}
        </DialogContentContainer>
        <DialogFooter>
          <Button theme="secondary" onClick={() => setRegion(null)}>
            Clear region
          </Button>
          <Button theme="primary" disabled={!url} onClick={() => void save()}>
            Save annotation
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
