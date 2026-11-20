// Clears the DOM between tests (Vitest runs without globals, so Testing Library's automatic cleanup does not register).
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());
