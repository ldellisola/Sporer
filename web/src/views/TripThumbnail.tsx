import type { LonLat } from "../api/types";
import styles from "./TripThumbnail.module.css";

const WIDTH = 72;
const HEIGHT = 48;
/** Air between the line and the edge of the box, so that the stroke and the dots are not cut. */
const PADDING = 4;
const DOT_RADIUS = 2.5;
const DEGREES = Math.PI / 180;

/** A coordinate as the picture writes it: to a tenth of a pixel, without a trailing zero ("44", "36.8"). */
const px = (value: number): string => String(Math.round(value * 10) / 10);

/**
 * The line as points of the box, or null when there is no line to draw: no point at all, or points that are all the one position.
 *
 * The projection is the plain one, equirectangular, which is all a picture of 72 by 48 pixels needs: a degree of longitude is as wide as
 * a degree of latitude times the cosine of the middle latitude (so that Oslo and Lisbon are not stretched sideways), north is up, and
 * the line is scaled until it touches the box inside its padding on the side it is longest, and then stands in the middle of the box.
 */
function project(line: readonly LonLat[]): [x: number, y: number][] | null {
  if (line.length === 0) return null;
  const lons = line.map(([lon]) => lon);
  const lats = line.map(([, lat]) => lat);
  const [west, east] = [Math.min(...lons), Math.max(...lons)];
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const across = Math.cos(((south + north) / 2) * DEGREES); // pixels of width for a degree of longitude, for one for a degree of latitude
  const spanX = (east - west) * across;
  const spanY = north - south;
  const roomX = WIDTH - 2 * PADDING;
  const roomY = HEIGHT - 2 * PADDING;
  const scale =
    spanX > 0 && spanY > 0 ? Math.min(roomX / spanX, roomY / spanY) : spanX > 0 ? roomX / spanX : spanY > 0 ? roomY / spanY : 0;
  if (scale === 0) return null;
  const left = PADDING + (roomX - spanX * scale) / 2;
  const top = PADDING + (roomY - spanY * scale) / 2;
  return line.map(([lon, lat]) => [left + (lon - west) * across * scale, top + (north - lat) * scale]);
}

/**
 * Where a trip went, drawn small for its card: its line, in the accent colour, with a dot at each point between the ends (where it slept).
 * A trip that is `ongoing` has not come home, so its line stops at the place it is at now: that last point is somewhere it slept, not an
 * end that is home again, and gets its dot too (a one-night trip so far is home and one dot). A line that has one point, none, or only the
 * one position over and over (a trip that is not known to have gone anywhere) is one dot in the middle. It is a picture only: the card
 * says what it is of.
 */
export function TripThumbnail({ line, ongoing = false }: { line: readonly LonLat[]; ongoing?: boolean }) {
  const points = project(line);
  return (
    <svg className={styles.thumbnail} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width={WIDTH} height={HEIGHT} aria-hidden="true" focusable="false">
      {points === null ? (
        <circle className={styles.dot} cx={px(WIDTH / 2)} cy={px(HEIGHT / 2)} r={DOT_RADIUS} />
      ) : (
        <>
          <path className={styles.line} d={points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${px(x)},${px(y)}`).join(" ")} />
          {(ongoing ? points.slice(1) : points.slice(1, -1)).map(([x, y], i) => (
            <circle key={i} className={styles.dot} cx={px(x)} cy={px(y)} r={DOT_RADIUS} />
          ))}
        </>
      )}
    </svg>
  );
}
