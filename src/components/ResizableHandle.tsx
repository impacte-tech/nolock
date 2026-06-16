import { useCallback, useEffect, useRef } from "react";

interface Props {
  /** "horizontal" = drag left/right (vertical divider bar), "vertical" = drag up/down (horizontal divider bar) */
  direction: "horizontal" | "vertical";
  /** Called on every mouse move with the delta in pixels since the last event */
  onDrag: (delta: number) => void;
  /** Called when the drag ends (mouse up).  Useful for triggering a final
   *  position sync on the browser webview after the layout has settled. */
  onDragEnd?: () => void;
}

/**
 * A thin, visually distinct resize handle that the user can drag to resize
 * adjacent panels.  Uses document-level mouse events so dragging works even
 * when the pointer leaves the handle element (fast drags).
 *
 * Renders a `<div>` styled via CSS classes:
 *   `.resize-handle`              — shared styles
 *   `.resize-handle--horizontal`  — vertical divider (dragged left/right)
 *   `.resize-handle--vertical`    — horizontal divider (dragged up/down)
 *
 * Performance note: onDrag is stored in a ref so the effect (which registers
 * document-level listeners) only runs once per `direction` change, not on
 * every render caused by the parent's state updates during drag.
 */
export default function ResizableHandle({ direction, onDrag, onDragEnd }: Props) {
  const isDragging = useRef(false);
  const lastPos = useRef(0);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;

      // Set cursor on body while dragging to avoid flickering
      document.body.style.cursor =
        direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [direction],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const currentPos =
        direction === "horizontal" ? e.clientX : e.clientY;
      const delta = currentPos - lastPos.current;
      lastPos.current = currentPos;
      onDragRef.current(delta);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onDragEndRef.current?.();
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [direction]); // onDrag intentionally omitted — accessed via ref

  return (
    <div
      className={`resize-handle resize-handle--${direction}`}
      onMouseDown={onMouseDown}
    />
  );
}
