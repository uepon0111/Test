
import { clone } from './utils.js';

const KEY = 'ghpages_nocode_builder_v1';

export const loadState = () => {
  try{
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){
    console.warn('loadState failed', e);
    return null;
  }
};

export const saveState = (state) => {
  try{
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  }catch(e){
    console.warn('saveState failed', e);
    return false;
  }
};

export const clearState = () => localStorage.removeItem(KEY);

export const exportStateJson = (state) => new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });

export const importStateFromJson = async (file) => {
  const text = await file.text();
  return JSON.parse(text);
};

export const cloneState = (state) => clone(state);
