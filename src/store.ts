import React, { createContext, useContext } from "react";
import type { Instance, Screen } from "./data/types.js";

export interface AppState {
  screen: Screen;
  selectedIndex: number;
  selectedInstance: Instance | null;
  setScreen: (screen: Screen) => void;
  setSelectedIndex: (index: number) => void;
  setSelectedInstance: (instance: Instance | null) => void;
}

export const AppContext = createContext<AppState>({
  screen: "dashboard",
  selectedIndex: 0,
  selectedInstance: null,
  setScreen: () => {},
  setSelectedIndex: () => {},
  setSelectedInstance: () => {},
});

export function useApp(): AppState {
  return useContext(AppContext);
}
