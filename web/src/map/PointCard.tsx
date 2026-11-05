import type { MapLibreMap } from "maplibre-gl";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isNotFound } from "../api/client";
import { usePointDetail } from "../api/queries";
import type { InspectedPoint, PointDetailResponse } from "../api/types";
import { ErrorState } from "../views/States";
import type { Insets } from "./AreaSelect";
import { placeCard, samePlace, type CardPlace } from "./cardPlace";
import styles from "./PointCard.module.css";
import {
  formatCoordinates,
  formatMetres,
  formatSpeedMps,
  localClock,
  localDate,
  neighbourText,
  NOT_RECORDED,
  segmentText,
  statusText,
  zoneName,
} from "./pointCardText";

/** How far the card is from the point, which leaves room for its pointer. */
const GAP = 12;
/** What the map's buttons take at the right, beyond the padding: their margin (12 px), their width (44 px) and a gap: the card keeps clear of them, so that Select area is still there to turn off. */
const CONTROLS_AIR = 12 + 44 + 8;

export interface PointCardProps {
  /** The map, which the point is put on the screen by: the card follows it as it moves. */
  map: MapLibreMap | null;
  /** The point the card is of. */
  point: InspectedPoint;
  /** The part of the map that is covered, and the air round it: the card is kept in what is free. */
  within: Insets;
  /** Called for the ×, and for Escape. */
  onClose: () => void;
}

/** One row of the card: a label and what it says. */
function Row({ label, children }: { label: string; children: string }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Details({ detail }: { detail: PointDetailResponse }) {
  const place = segmentText(detail.segment, detail.zone);
  return (
    <>
      <p className={styles.heading}>
        <span className={styles.time}>
          {localClock(detail.localTime)} {zoneName(detail.t, detail.zone)}
        </span>
        <span className={styles.date}>{localDate(detail.localTime)}</span>
      </p>
      <p className={detail.status === "used" ? styles.status : `${styles.status} ${styles.ignored}`}>{statusText(detail)}</p>
      <dl className={styles.rows}>
        <Row label="Device">{detail.device}</Row>
        <Row label="Coordinates">{formatCoordinates(detail.lat, detail.lon)}</Row>
        <Row label="Accuracy">{detail.accuracyM === null ? NOT_RECORDED : formatMetres(detail.accuracyM)}</Row>
        <Row label="Speed">{detail.speedMps === null ? NOT_RECORDED : formatSpeedMps(detail.speedMps)}</Row>
        <Row label="Altitude">{formatMetres(detail.altitudeM)}</Row>
        <Row label="Motion">{detail.motion === null || detail.motion.length === 0 ? NOT_RECORDED : detail.motion.join(", ")}</Row>
      </dl>
      {place !== null && <p className={styles.line}>{place}</p>}
      <p className={styles.line}>{neighbourText(detail.previous, "previous")}</p>
      <p className={styles.line}>{neighbourText(detail.next, "next")}</p>
    </>
  );
}

/**
 * The card of one point in edit mode, on the map at the point (above it, or below it when there is no room, and in what the sheet and the bar leave free of
 * the map), which follows the map as it moves: its time, what the device said of it, whether the timeline uses it and why not, where in the day it is, and how
 * far it is from the points either side. It is a region of the map, named "Point details", and takes no focus when it opens (the owner is tapping on the
 * map, and the map keeps the focus; the keyboard goes on from there): the × is a button, and Escape closes it as well. A point that is gone says so (a 404,
 * which asking again cannot change), and any other failure has Retry.
 */
export function PointCard({ map, point, within, onClose }: PointCardProps) {
  const detail = usePointDetail(point);
  const { data, error, isPending, refetch } = detail;
  const card = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CardPlace | null>(null);

  // Where it goes, from where the map has the point and how large the card is now. The card is measured as it is (the place it was in only limits its size).
  const arrange = useCallback((): void => {
    const element = card.current;
    const inside = content.current;
    const host = element?.parentElement;
    if (map === null || element === null || inside === null || host === null || host === undefined) return;
    const at = map.project([point.lon, point.lat]);
    const area = { left: within.left, top: within.top, right: host.clientWidth - within.right - CONTROLS_AIR, bottom: host.clientHeight - within.bottom };
    const size = { width: element.offsetWidth, height: inside.scrollHeight + 2 }; // and its border
    setPlace((last) => {
      const next = placeCard(at, size, area, GAP);
      return last !== null && samePlace(last, next) ? last : next; // a card that is where it was is not drawn again
    });
  }, [map, point, within]);

  useLayoutEffect(() => {
    arrange();
  }, [arrange, data, error, isPending]);

  useEffect(() => {
    if (map === null) return;
    map.on("move", arrange);
    map.on("resize", arrange);
    return () => {
      map.off("move", arrange);
      map.off("resize", arrange);
    };
  }, [map, arrange]);

  // Closing it while the focus is in it (the × by the keyboard, Escape after Tab) would drop the focus on the page: it goes to the map, which is where the owner was.
  const close = useCallback((): void => {
    if (card.current?.contains(document.activeElement)) map?.getCanvas().focus();
    onClose();
  }, [map, onClose]);
  const closeButton = useRef<HTMLButtonElement>(null);

  // Escape closes it, from wherever the focus is, unless something else took the key (a field that gives up on it, say) or the focus is in a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  let body;
  if (data !== undefined) body = <Details detail={data} />;
  else if (isNotFound(error)) body = <p className={styles.note}>This point no longer exists</p>;
  else if (error !== null) body = <ErrorState error={error} onRetry={() => {
          closeButton.current?.focus(); // Retry is replaced by the loading state, which would leave the focus on the page
          void refetch();
        }} message="Couldn't load the point" />;
  else body = <p className={styles.note}>Loading…</p>;

  return (
    <div
      ref={card}
      role="region"
      aria-label="Point details"
      className={styles.card}
      data-side={place?.side}
      data-no-area-select="" // a shift-drag that starts on the card is not the map's
      style={
        place === null
          ? { visibility: "hidden" }
          : { left: place.left, top: place.top, maxHeight: place.maxHeight, maxWidth: place.maxWidth, ["--pointer-x" as string]: `${place.pointerX}px` }
      }
    >
      <button ref={closeButton} type="button" className={styles.close} aria-label="Close point details" title="Close point details" onClick={close}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
      <div ref={content} className={styles.body}>
        {body}
      </div>
    </div>
  );
}
