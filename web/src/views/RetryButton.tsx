import styles from "./RetryButton.module.css";

/**
 * The way to try again that a line of text ends in: an error in the panel ("Couldn't load — Retry") and a note over the map
 * ("Couldn't load the heat map — Retry") have the same one, so that it looks and behaves the same wherever it is met.
 */
export function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={styles.retry} onClick={onClick}>
      Retry
    </button>
  );
}
