import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects } from "../state/entities";
import { useEnvironmentIdentities } from "../state/environments";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
    { mode: "legacy", count: 2, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
      legacySidebarEnabled: scenario.mode === "legacy",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

it("remembers the environment filter and limits the project picker to that environment", async () => {
  using stack = new DisposableStack();
  const identities = [
    { environmentId: EnvironmentId.make("local"), label: "Windows" },
    { environmentId: EnvironmentId.make("wsl"), label: "WSL Ubuntu" },
  ];
  vi.mocked(useEnvironmentIdentities).mockReturnValue(identities);
  stack.defer(() => vi.mocked(useEnvironmentIdentities).mockReset());
  vi.mocked(useProjects).mockReturnValue([
    project("win-project"),
    { ...project("pi-project"), environmentId: EnvironmentId.make("wsl") },
  ]);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef: null,
  });
  localStorage.removeItem("sidebar.environment-scope");
  stack.defer(() => localStorage.removeItem("sidebar.environment-scope"));
  const ui = () => (
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
  {
    await using screen = await render(ui());
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Filter threads by environment" }),
      "wsl",
    );
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter threads by project", exact: true }),
    );
    await expect.element(page.getByRole("option", { name: /^pi-project/ })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /^win-project/ }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
  }
  await using screen = await render(ui());
  await expect
    .element(screen.getByRole("combobox", { name: "Filter threads by environment" }))
    .toHaveValue("wsl");
});
