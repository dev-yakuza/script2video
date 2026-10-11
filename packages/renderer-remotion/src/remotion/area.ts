import { createContext, useContext } from 'react';
import { useVideoConfig } from 'remotion';

/** Frame margins kept free of visuals (speakers, subtitles). */
export type Area = { left: number; right: number; bottom: number };

export const AreaContext = createContext<Area>({ left: 0, right: 0, bottom: 0 });

/** Size available to a visual, and whether the frame uses portrait metrics. */
export function useVisualArea() {
  const area = useContext(AreaContext);
  const { width, height } = useVideoConfig();
  return {
    width: width - area.left - area.right,
    height: height - area.bottom,
    /** The frame itself (not the area) decides portrait sizing. */
    portrait: width < 1500,
    /** Speakers / subtitles already have their own band: no extra bottom padding needed. */
    reserved: area.bottom > 0,
  };
}
