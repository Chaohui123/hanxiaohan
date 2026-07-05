import { create } from "zustand";

interface AppState {
  currentStore: string;
  setCurrentStore: (id: string) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  apiKey: string;
  isAuthenticated: boolean;
  setApiKey: (key: string) => void;
  logout: () => void;
}

function getSavedApiKey(): string {
  try { return localStorage.getItem("onzo-api-key") || ""; }
  catch { return ""; }
}

function getSavedAuthState(): boolean {
  try { return !!localStorage.getItem("onzo-api-key"); }
  catch { return false; }
}

export const useAppStore = create<AppState>((set) => ({
  currentStore: "",
  setCurrentStore: (id) => set({ currentStore: id }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  apiKey: getSavedApiKey(),
  isAuthenticated: getSavedAuthState(),
  setApiKey: (key) => {
    try { localStorage.setItem("onzo-api-key", key); } catch {}
    set({ apiKey: key, isAuthenticated: true });
  },
  logout: () => {
    try { localStorage.removeItem("onzo-api-key"); } catch {}
    set({ apiKey: "", isAuthenticated: false });
  },
}));
