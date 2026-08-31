import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import {
  ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY,
  HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY,
  VAULT_PLAN_STORAGE_KEY,
} from "@/storage/vault-plan-storage";
import {
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
} from "@/storage/xpubless-v2-local-state";
import { startXpublessV2DevelopmentRuntime } from "@/storage/xpubless-v2-runtime";
import { TimeSatsApp } from "./timesats-app";

vi.mock("@/storage/xpubless-v2-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/storage/xpubless-v2-runtime")>();
  return { ...actual, startXpublessV2DevelopmentRuntime: vi.fn() };
});

const initialNodeEnvironment = process.env.NODE_ENV;
const initialDevelopmentGate = process.env.NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV;
const mutableEnvironment = process.env as Record<string, string | undefined>;

afterEach(() => {
  mutableEnvironment.NODE_ENV = initialNodeEnvironment;
  if (initialDevelopmentGate === undefined) delete mutableEnvironment.NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV;
  else mutableEnvironment.NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV = initialDevelopmentGate;
  vi.mocked(startXpublessV2DevelopmentRuntime).mockReset();
  [
    VAULT_PLAN_STORAGE_KEY,
    ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY,
    HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY,
    XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
    XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  ].forEach((key) => window.localStorage.removeItem(key));
});

describe("TimeSatsApp xpubless development gate", () => {
  it("keeps the unchanged legacy application path when the gate is off", () => {
    mutableEnvironment.NODE_ENV = "test";
    delete mutableEnvironment.NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV;

    render(<TimeSatsApp />);

    expect(screen.getAllByRole("button", { name: "Criar meu plano" })).not.toHaveLength(0);
    expect(startXpublessV2DevelopmentRuntime).not.toHaveBeenCalled();
  });

  it("mounts only the read-only development shell when the gate is enabled", async () => {
    mutableEnvironment.NODE_ENV = "development";
    mutableEnvironment.NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV = "1";
    vi.mocked(startXpublessV2DevelopmentRuntime).mockResolvedValue({ status: "XPUBLESS_READY", state: {
      format: "timesats-xpubless-local-state",
      version: 1,
      stateId: "11111111-1111-4111-8111-111111111111",
      revision: 0,
      plans: [],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    } });

    render(<StrictMode><TimeSatsApp /></StrictMode>);

    expect(screen.getByRole("heading", { name: "Xpubless V2" })).toBeVisible();
    await waitFor(() => expect(startXpublessV2DevelopmentRuntime).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Criar meu plano" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Adicionar Bitcoin/i })).not.toBeInTheDocument();
  });

  it("keeps the development shell read-only if startup rejects unexpectedly", async () => {
    mutableEnvironment.NODE_ENV = "development";
    mutableEnvironment.NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV = "1";
    vi.mocked(startXpublessV2DevelopmentRuntime).mockRejectedValue(new Error("Injected unexpected startup failure."));

    render(<TimeSatsApp />);

    await waitFor(() => expect(screen.getByText(/armazenamento local não pôde ser lido/i)).toBeVisible());
    expect(screen.queryByRole("button", { name: "Criar meu plano" })).not.toBeInTheDocument();
  });
});
