/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppState } from './types';

const STORAGE_KEY = 'railway_sim_data_v1';

export const loadState = (): AppState => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load state', e);
    }
  }
  
  // Initial demo data
  const s1Id = 's1';
  const s2Id = 's2';
  return {
    stations: [
      { id: s1Id, name: '駅1', gx: 4, gy: 4, platforms: 2, isVertical: false },
      { id: s2Id, name: '駅2', gx: 12, gy: 8, platforms: 1, isVertical: false },
    ],
    nodes: [
        { id: 'b1', gx: 8, gy: 6 }
    ],
    tracks: [
        { id: 't1', fromId: 's1-p0-e', toId: 'b1', timePerGrid: 5 },
        { id: 't2', fromId: 'b1', toId: 's2-p0-s', timePerGrid: 5 }
    ],
    trains: [],
  };
};

export const saveState = (state: AppState) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

export const formatTime = (seconds: number) => {
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export const parseTime = (timeStr: string): number => {
  const [h, m, s] = timeStr.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
};

// 座標・距離計算
export const getDistance = (x1: number, y1: number, x2: number, y2: number) => {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
};
