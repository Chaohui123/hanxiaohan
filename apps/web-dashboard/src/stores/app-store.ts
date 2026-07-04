import { create } from "zustand";

interface AppState {
  currentStore: string;
  setCurrentStore: (id: string) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentStore: "",
  setCurrentStore: (id) => set({ currentStore: id }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
