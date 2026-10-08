// Limpa o DOM entre testes (o Vitest roda sem globals, então a limpeza automática da Testing Library não se registra).
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());
