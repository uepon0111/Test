/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  TrainFront, 
  Map as MapIcon, 
  Settings, 
  Clock, 
  Play, 
  Pause, 
  Plus, 
  Trash2, 
  RotateCcw,
  Maximize2,
  Minimize2,
  ChevronRight,
  ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Station, 
  TrackSegment, 
  TrainPattern, 
  SimulationState, 
  AppData,
  Orientation,
  Point,
  RouteStep
} from './types';

// Constants
const GRID_SIZE = 40;
const STORAGE_KEY = 'railway_sim_data_v1';

export default function App() {
  // --- State ---
  const [activeTab, setActiveTab] = useState<'station' | 'track' | 'schedule' | 'sim'>('station');
  const [stations, setStations] = useState<Station[]>([]);
  const [tracks, setTracks] = useState<TrackSegment[]>([]);
  const [trains, setTrains] = useState<TrainPattern[]>([]);
  
  const [simState, setSimState] = useState<SimulationState>({
    currentTime: 480, // 08:00
    speed: 1,
    isPlaying: false
  });

  const [viewOffset, setViewOffset] = useState({ x: 100, y: 100 });
  const [zoom, setZoom] = useState(1);
  const mapRef = useRef<HTMLDivElement>(null);
  
  // Track Editor State
  const [trackStart, setTrackStart] = useState<Point | null>(null);

  // --- Persistence ---
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data: AppData = JSON.parse(saved);
        setStations(data.stations || []);
        setTracks(data.tracks || []);
        setTrains(data.trains || []);
      } catch (e) {
        console.error("Failed to load data", e);
      }
    }
  }, []);

  useEffect(() => {
    const data: AppData = { stations, tracks, trains };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [stations, tracks, trains]);

  // --- Simulation Loop ---
  useEffect(() => {
    let lastTime = performance.now();
    let frameId: number;

    const tick = (now: number) => {
      if (simState.isPlaying) {
        const deltaMs = now - lastTime;
        // speed of 1 = real time. 1 minute in sim = 1 minute real time?
        // Actually, let's make 1 minute in sim = 1 second at 1x speed for better experience
        const simMinutesPerSec = 1; 
        const deltaMinutes = (deltaMs / 1000) * simMinutesPerSec * simState.speed;
        
        setSimState(prev => ({
          ...prev,
          currentTime: (prev.currentTime + deltaMinutes) % 1440
        }));
      }
      lastTime = now;
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [simState.isPlaying, simState.speed]);

  // --- Helpers ---
  const formatTime = (totalMinutes: number) => {
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = Math.floor(totalMinutes % 60);
    const s = Math.floor((totalMinutes * 60) % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // --- Handlers ---
  const handleMapClick = (e: React.MouseEvent) => {
    if (!mapRef.current) return;
    const rect = mapRef.current.getBoundingClientRect();
    const mapX = (e.clientX - rect.left - viewOffset.x) / zoom;
    const mapY = (e.clientY - rect.top - viewOffset.y) / zoom;
    const gridX = Math.round(mapX / GRID_SIZE);
    const gridY = Math.round(mapY / GRID_SIZE);

    if (activeTab === 'station') {
      const id = `stn_${Date.now()}`;
      setStations([...stations, {
        id,
        name: `駅 ${stations.length + 1}`,
        x: gridX,
        y: gridY,
        platforms: 2,
        orientation: 'horizontal'
      }]);
    } else if (activeTab === 'track') {
      const currentPoint = { x: gridX, y: gridY };
      if (!trackStart) {
        setTrackStart(currentPoint);
      } else {
        if (trackStart.x !== currentPoint.x || trackStart.y !== currentPoint.y) {
          const newTrack: TrackSegment = {
            id: `trc_${Date.now()}`,
            start: trackStart,
            end: currentPoint,
            travelTime: 1 // default 1 min
          };
          setTracks([...tracks, newTrack]);
        }
        setTrackStart(null);
      }
    }
  };

  const deleteStation = (id: string) => {
    setStations(stations.filter(s => s.id !== id));
  };

  const updateStation = (id: string, updates: Partial<Station>) => {
    setStations(stations.map(s => s.id === id ? { ...s, ...updates } : s));
  };

  const deleteTrack = (id: string) => {
    setTracks(tracks.filter(t => t.id !== id));
  };

  return (
    <div className="fixed inset-0 bg-[#f8f9fa] flex flex-col font-sans text-slate-900 overflow-hidden">
      {/* Header */}
      <header className="h-14 border-b bg-white flex items-center justify-between px-6 shadow-sm z-30">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-xl text-white shadow-indigo-100 shadow-lg">
            <TrainFront size={24} />
          </div>
          <div className="flex flex-col">
            <h1 className="font-extrabold text-xl tracking-tighter text-indigo-950 leading-none">RailMaster</h1>
            <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mt-1">Railway Simulator</span>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
             <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-100 px-4 py-1.5 rounded-full shadow-inner">
                <Clock size={16} className="text-indigo-500" />
                <span className="font-mono text-lg font-bold text-indigo-900 leading-none">{formatTime(simState.currentTime).split(':').slice(0,2).join(':')}</span>
                <span className="font-mono text-xs font-bold text-indigo-400">:{formatTime(simState.currentTime).split(':')[2]}</span>
             </div>
          </div>
        </div>
      </header>

      {/* Main Simulation View */}
      <main className="relative flex-1 bg-[#eef2f6] overflow-hidden cursor-crosshair" ref={mapRef} onClick={handleMapClick}>
        <div 
          className="absolute inset-0 transition-transform duration-75 origin-top-left"
          style={{ transform: `translate(${viewOffset.x}px, ${viewOffset.y}px) scale(${zoom})` }}
        >
          {/* Grid Background */}
          <svg className="absolute inset-0 w-[20000px] h-[20000px] pointer-events-none" style={{ left: -10000, top: -10000 }}>
            <defs>
              <pattern id="smallGrid" width={GRID_SIZE/2} height={GRID_SIZE/2} patternUnits="userSpaceOnUse">
                <path d={`M ${GRID_SIZE/2} 0 L 0 0 0 ${GRID_SIZE/2}`} fill="none" stroke="#e2e8f0" strokeWidth="0.5" />
              </pattern>
              <pattern id="grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
                <rect width={GRID_SIZE} height={GRID_SIZE} fill="url(#smallGrid)" />
                <path d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`} fill="none" stroke="#cbd5e1" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>

          {/* Render Tracks */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
            {tracks.map(track => (
              <g key={track.id}>
                 <line 
                  x1={track.start.x * GRID_SIZE}
                  y1={track.start.y * GRID_SIZE}
                  x2={track.end.x * GRID_SIZE}
                  y2={track.end.y * GRID_SIZE}
                  stroke="#334155"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
                <line 
                  x1={track.start.x * GRID_SIZE}
                  y1={track.start.y * GRID_SIZE}
                  x2={track.end.x * GRID_SIZE}
                  y2={track.end.y * GRID_SIZE}
                  stroke="#94a3b8"
                  strokeWidth="2"
                  strokeDasharray="4 4"
                  strokeLinecap="round"
                />
              </g>
            ))}
            {/* Active drawing track */}
            {trackStart && activeTab === 'track' && (
               <line 
                x1={trackStart.x * GRID_SIZE}
                y1={trackStart.y * GRID_SIZE}
                x2={(trackStart.x + 1) * GRID_SIZE} // Placeholder
                y2={(trackStart.y + 1) * GRID_SIZE}
                stroke="#6366f1"
                strokeWidth="4"
                strokeDasharray="8 4"
                className="animate-pulse"
               />
            )}
          </svg>

          {/* Render Stations */}
          {stations.map(station => (
            <StationComponent 
              key={station.id} 
              station={station} 
              onDelete={() => deleteStation(station.id)}
              onUpdate={(updates) => updateStation(station.id, updates)}
            />
          ))}

          {/* Render Trains */}
          {trains.map(train => (
            <TrainComponent 
              key={train.id} 
              train={train} 
              currentTime={simState.currentTime} 
              stations={stations} 
              tracks={tracks} 
            />
          ))}
        </div>

        {/* Floating View Controls */}
        <div className="absolute top-6 right-6 flex flex-col gap-3 z-20">
          <div className="bg-white/80 backdrop-blur-md rounded-2xl shadow-xl border border-white flex flex-col p-1 gap-1">
            <ControlButton onClick={() => setZoom(z => Math.min(z * 1.2, 5))} icon={Maximize2} title="拡大" />
            <ControlButton onClick={() => setZoom(z => Math.max(z / 1.2, 0.2))} icon={Minimize2} title="縮小" />
            <div className="h-px bg-slate-200 mx-2" />
            <ControlButton onClick={() => { setViewOffset({x:100, y:100}); setZoom(1); }} icon={RotateCcw} title="リセット" />
          </div>
        </div>

        {/* Legend/Mode Indicator */}
        <div className="absolute top-6 left-6 z-20">
          <div className="bg-indigo-600 text-white px-4 py-2 rounded-2xl shadow-lg border border-indigo-400 flex items-center gap-2 font-bold text-xs uppercase tracking-widest">
            <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
            モード: {
              activeTab === 'station' ? '駅配置' :
              activeTab === 'track' ? '配線' :
              activeTab === 'schedule' ? 'ダイヤ設定' : '実行'
            }
          </div>
        </div>
      </main>

      {/* Control Panel Drawer */}
      <footer className="bg-white border-t rounded-t-[32px] shadow-2xl z-30 flex flex-col overflow-hidden max-h-[450px]">
        {/* Tab Navigation */}
        <nav className="flex px-8 pt-4 gap-2">
          <PanelTab active={activeTab === 'station'} onClick={() => setActiveTab('station')} icon={MapIcon} label="駅配置" />
          <PanelTab active={activeTab === 'track'} onClick={() => setActiveTab('track')} icon={Settings} label="配線" />
          <PanelTab active={activeTab === 'schedule'} onClick={() => setActiveTab('schedule')} icon={Clock} label="ダイヤ設定" />
          <PanelTab active={activeTab === 'sim'} onClick={() => setActiveTab('sim')} icon={Play} label="実行" />
        </nav>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto px-8 py-6 mb-4 scrollbar-hide">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'station' && <StationList stations={stations} onUpdate={updateStation} onDelete={deleteStation} />}
              {activeTab === 'track' && <TrackList tracks={tracks} onDelete={deleteTrack} />}
              {activeTab === 'schedule' && <SchedulePanel trains={trains} setTrains={setTrains} stations={stations} tracks={tracks} />}
              {activeTab === 'sim' && <ExecutionPanel state={simState} setState={setSimState} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </footer>
    </div>
  );
}

// --- Sub-Components ---

function ControlButton({ onClick, icon: Icon, title }: any) {
  return (
    <button 
      onClick={onClick}
      title={title}
      className="w-10 h-10 flex items-center justify-center text-slate-600 hover:text-indigo-600 hover:bg-white rounded-xl transition-all"
    >
      <Icon size={20} />
    </button>
  );
}

function PanelTab({ active, onClick, icon: Icon, label }: any) {
  return (
    <button 
      onClick={onClick}
      className={`relative px-6 py-3 flex items-center gap-2 font-black text-sm transition-all ${active ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
    >
      <Icon size={20} className={active ? 'scale-110' : ''} />
      {label}
      {active && <motion.div layoutId="tabUnderline" className="absolute bottom-0 left-0 right-0 h-1 bg-indigo-600 rounded-full" />}
    </button>
  );
}

function StationComponent({ station, onUpdate, onDelete }: any) {
  const isHoriz = station.orientation === 'horizontal';
  const widthUnits = isHoriz ? 2 : station.platforms;
  const heightUnits = isHoriz ? station.platforms : 2;

  return (
    <div 
      className="absolute bg-white/90 backdrop-blur-sm border-2 border-slate-900 rounded-lg shadow-xl z-10 overflow-hidden flex flex-col items-center justify-center transition-transform hover:scale-[1.02]"
      style={{
        left: station.x * GRID_SIZE,
        top: station.y * GRID_SIZE,
        width: widthUnits * GRID_SIZE,
        height: heightUnits * GRID_SIZE,
      }}
    >
      <div className={`absolute inset-0 flex ${isHoriz ? 'flex-col' : 'flex-row'}`}>
        {Array.from({ length: station.platforms }).map((_, i) => (
          <div key={i} className={`flex-1 border-slate-300 border-dashed ${isHoriz ? 'border-b last:border-b-0' : 'border-r last:border-r-0'}`} />
        ))}
      </div>
      <div className="relative z-10 bg-slate-900 text-white px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter">
        {station.name}
      </div>
    </div>
  );
}

function StationList({ stations, onUpdate, onDelete }: any) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {stations.map((s: Station) => (
        <div key={s.id} className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col gap-3 group relative hover:border-indigo-300 transition-all shadow-sm hover:shadow-md">
          <div className="flex items-center gap-3">
            <div className="bg-white p-2 rounded-xl shadow-sm border border-slate-100">
              <MapIcon size={18} className="text-slate-400" />
            </div>
            <input 
              className="bg-transparent font-black tracking-tight text-slate-800 outline-none flex-1 border-b-2 border-transparent focus:border-indigo-500" 
              value={s.name} 
              onChange={e => onUpdate(s.id, { name: e.target.value })}
            />
          </div>
          <div className="flex justify-between items-end">
            <div className="flex gap-4">
              <div className="flex flex-col">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">ホーム数</span>
                <input 
                  type="number" 
                  className="w-12 font-bold text-sm bg-white border border-slate-200 rounded-lg px-2 py-1"
                  value={s.platforms} 
                  onChange={e => onUpdate(s.id, { platforms: parseInt(e.target.value) || 1 })}
                />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">向き</span>
                <button 
                  onClick={() => onUpdate(s.id, { orientation: s.orientation === 'horizontal' ? 'vertical' : 'horizontal' })}
                  className="px-3 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                >
                  {s.orientation === 'horizontal' ? '横' : '縦'}
                </button>
              </div>
            </div>
            <button onClick={() => onDelete(s.id)} className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all">
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      ))}
      {stations.length === 0 && (
        <div className="col-span-full h-40 flex flex-col items-center justify-center text-slate-300 border-2 border-dashed rounded-3xl gap-2">
          <MapIcon size={48} opacity={0.3} />
          <p className="font-bold">マップをクリックして駅を追加してください</p>
        </div>
      )}
    </div>
  );
}

function TrackList({ tracks, onDelete }: any) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {tracks.map((t: TrackSegment) => (
        <div key={t.id} className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex items-center justify-between group h-16 shadow-sm">
           <div className="flex items-center gap-3">
             <div className="bg-white p-2 rounded-xl shadow-sm">
               <Settings size={18} className="text-slate-400" />
             </div>
             <div className="font-mono text-xs font-bold text-slate-600">
               ({t.start.x},{t.start.y}) <ChevronRight size={12} className="inline mx-1"/> ({t.end.x},{t.end.y})
             </div>
           </div>
           <button onClick={() => onDelete(t.id)} className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all">
             <Trash2 size={18} />
           </button>
        </div>
      ))}
      {tracks.length === 0 && (
        <div className="col-span-full h-40 flex flex-col items-center justify-center text-slate-300 border-2 border-dashed rounded-3xl gap-2">
          <Settings size={48} opacity={0.3} />
          <p className="font-bold">2点を繋いで配線を作成してください</p>
        </div>
      )}
    </div>
  );
}

function SchedulePanel({ trains, setTrains, stations, tracks }: any) {
  const addTrain = () => {
    const id = `tr_${Date.now()}`;
    const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'];
    setTrains([...trains, {
      id,
      name: `列車 ${trains.length + 1}`,
      color: colors[trains.length % colors.length],
      startTime: 480,
      interval: 30,
      steps: []
    }]);
  };

  const deleteTrain = (id: string) => setTrains(trains.filter((t: any) => t.id !== id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-black text-slate-400 text-xs uppercase tracking-widest">運行リスト</h3>
        <button onClick={addTrain} className="bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold text-xs flex items-center gap-2 hover:bg-indigo-700 shadow-lg shadow-indigo-100 transition-all">
          <Plus size={16}/> 列車を追加
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {trains.map((t: TrainPattern) => (
          <div key={t.id} className="bg-white border-2 border-slate-100 rounded-3xl p-5 shadow-sm hover:shadow-xl transition-all flex flex-col gap-4">
             <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                   <div className="w-8 h-8 rounded-full border-2 border-white shadow-md" style={{ backgroundColor: t.color }} />
                   <input 
                     className="bg-transparent font-black tracking-tight text-slate-800 outline-none w-32 "
                     value={t.name}
                     onChange={e => setTrains(trains.map((tr: any) => tr.id === t.id ? {...tr, name: e.target.value} : tr))}
                   />
                </div>
                <button onClick={() => deleteTrain(t.id)} className="p-2 text-slate-200 hover:text-red-500 rounded-lg transition-colors">
                  <Trash2 size={16} />
                </button>
             </div>
             
             <div className="grid grid-cols-2 gap-4">
               <div>
                  <label className="text-[10px] font-black text-slate-400 capitalize mb-1 block">始発時刻</label>
                  <input 
                    type="time"
                    className="w-full p-2 bg-slate-50 border rounded-xl font-bold text-sm"
                    value={Math.floor(t.startTime/60).toString().padStart(2,'0')+':'+(t.startTime%60).toString().padStart(2,'0')}
                    onChange={e => {
                      const [h, m] = e.target.value.split(':').map(Number);
                      setTrains(trains.map((tr: any) => tr.id === t.id ? {...tr, startTime: h*60+m} : tr));
                    }}
                  />
               </div>
               <div>
                  <label className="text-[10px] font-black text-slate-400 capitalize mb-1 block">運転間隔 (分)</label>
                  <input 
                    type="number"
                    className="w-full p-2 bg-slate-50 border rounded-xl font-bold text-sm"
                    value={t.interval}
                    onChange={e => setTrains(trains.map((tr: any) => tr.id === t.id ? {...tr, interval: parseInt(e.target.value) || 0} : tr))}
                  />
               </div>
             </div>

             <div className="mt-2 space-y-2">
               <div className="p-3 bg-slate-50 border border-slate-100 rounded-2xl">
                  {/* Mock for Step 1 in user pattern (1) */}
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                       <span className="text-[10px] font-black text-indigo-500 bg-indigo-50 px-1.5 rounded uppercase">駅A / 停車</span>
                       <span className="font-mono text-xs font-bold text-slate-400">08:00 発</span>
                    </div>
                    <div className="h-4 border-l-2 border-dashed border-slate-300 ml-2 my-1 flex items-center">
                       <ChevronDown size={10} className="text-slate-300 absolute -bottom-1 left-[-6px]" />
                    </div>
                    <div className="flex items-center justify-between">
                       <span className="text-[10px] font-black text-slate-500 italic">分岐a / 通過</span>
                       <span className="font-mono text-xs font-bold text-slate-400">08:15</span>
                    </div>
                  </div>
               </div>
               <button className="w-full py-2 bg-indigo-50 text-indigo-600 font-bold text-[10px] uppercase rounded-xl hover:bg-indigo-100 transition-colors flex items-center justify-center gap-1">
                 <Settings size={12}/> 経路を編集する
               </button>
             </div>
          </div>
        ))}
        {trains.length === 0 && (
          <div className="col-span-full h-40 flex flex-col items-center justify-center text-slate-300 border-2 border-dashed rounded-3xl gap-2">
            <TrainFront size={48} opacity={0.3} />
            <p className="font-bold">列車を追加して運行計画を立てましょう</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ExecutionPanel({ state, setState }: any) {
  const speeds = [1, 5, 10, 30, 60, 120];

  return (
    <div className="flex flex-col md:flex-row items-center gap-12 justify-center py-4">
      <div className="flex flex-col items-center gap-4">
        <button 
          onClick={() => setState({ ...state, isPlaying: !state.isPlaying })}
          className={`w-24 h-24 rounded-full flex items-center justify-center transition-all shadow-2xl ${state.isPlaying ? 'bg-amber-100 text-amber-600 border border-amber-200 shadow-amber-100' : 'bg-indigo-600 text-white shadow-indigo-200'}`}
        >
          {state.isPlaying ? <Pause size={48} fill="currentColor"/> : <Play size={48} fill="currentColor" className="ml-2"/>}
        </button>
        <span className="font-black text-[10px] text-slate-400 uppercase tracking-[0.2em]">{state.isPlaying ? '運転中' : '停止中'}</span>
      </div>

      <div className="flex flex-col gap-6 w-full max-w-lg">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">運行速度</span>
            <div className="flex gap-1 mt-2">
              {speeds.map(s => (
                <button 
                  key={s}
                  onClick={() => setState({ ...state, speed: s })}
                  className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all ${state.speed === s ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
        </div>
        
        <div className="space-y-3">
          <div className="flex justify-between items-end">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">タイムシーク</span>
            <span className="font-mono text-xs font-bold text-indigo-600">{Math.floor(state.currentTime/60).toString().padStart(2,'0')}:{Math.floor(state.currentTime%60).toString().padStart(2,'0')}</span>
          </div>
          <input 
            type="range"
            min="0"
            max="1439"
            value={state.currentTime}
            onChange={e => setState({ ...state, currentTime: parseInt(e.target.value) })}
            className="w-full h-4 bg-slate-100 rounded-full appearance-none cursor-pointer accent-indigo-600 border-4 border-white shadow-inner"
          />
        </div>
      </div>
    </div>
  );
}

function TrainComponent({ train, currentTime, stations, tracks }: any) {
  // Movement logic would go here. For the placeholder, I'll return null to keep it clean.
  // In a full implementation, you'd calculate the segment based on currentTime and train.steps
  return null;
}
