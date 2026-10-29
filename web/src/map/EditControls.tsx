import type { MapLibreMap } from "maplibre-gl";
import type { RefObject } from "react";
import { AreaSelect, type Insets, type Pixel, type PixelBox } from "./AreaSelect";
import { editPointAt, editPointsIn, useEditGestures, type MapEdit } from "./editPoints";
import type { EditPointCollection } from "./layers";
import styles from "./MapView.module.css";

export interface EditControlsProps {
  /** Edit mode, which these controls are of: they are there for as long as it is given. */
  edit: MapEdit;
  /** The map, once it is made: the points are put on the screen by it. */
  map: MapLibreMap | null;
  /** The points that are drawn, which a rectangle selects from. */
  points: EditPointCollection | undefined;
  /** The element of the map, which the layer of the selection is put in. */
  host: RefObject<HTMLElement | null>;
  /** The part of the map that is covered, and the air round it: a rectangle is cut to what is free. */
  within: Insets;
}

/**
 * What the map has of its own for edit mode, as one thing that the map makes while it is in it: the Select area button, which sits in the group of the
 * map's buttons (this is made inside it) and is pressed to turn the selection of an area on and off, and the selection itself (`AreaSelect`: a layer
 * over the whole of the map, which is put in its element). A rectangle selects the points that the map puts inside it; a tap on the surface of Select
 * area, which the map never saw, selects the point near it. The gestures of the map that edit mode takes over give way while this is there (`useEditGestures`).
 */
export function EditControls({ edit, map, points, host, within }: EditControlsProps) {
  useEditGestures(map, edit.area);
  const onBox = (box: PixelBox): void => {
    if (map !== null) edit.onSelect(editPointsIn(map, box, points));
  };
  const onTap = (point: Pixel): void => {
    const id = map === null ? undefined : editPointAt(map, point, points);
    if (id !== undefined) edit.onToggle(id);
  };
  return (
    <>
      <button
        type="button"
        className={styles.button}
        aria-label="Select area"
        title="Select area"
        aria-pressed={edit.area}
        onClick={() => edit.onAreaChange(!edit.area)}
      >
        {/* A dashed rectangle, as the one that is drawn. */}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <rect x="4.5" y="5.5" width="15" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3.2 2.6" />
        </svg>
      </button>
      <AreaSelect active={edit.area} host={host} within={within} onBox={onBox} onTap={onTap} />
    </>
  );
}
