import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only unmounts by itself when the test framework's globals are on; this keeps them off.
afterEach(cleanup);
