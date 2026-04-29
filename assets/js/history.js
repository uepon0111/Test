
import { clone } from './utils.js';

export class HistoryManager{
  constructor(limit = 80){
    this.limit = limit;
    this.stack = [];
    this.index = -1;
  }
  push(state){
    const snapshot = clone(state);
    if(this.index < this.stack.length - 1){
      this.stack = this.stack.slice(0, this.index + 1);
    }
    this.stack.push(snapshot);
    if(this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
  }
  canUndo(){ return this.index > 0; }
  canRedo(){ return this.index < this.stack.length - 1; }
  undo(){
    if(!this.canUndo()) return null;
    this.index -= 1;
    return clone(this.stack[this.index]);
  }
  redo(){
    if(!this.canRedo()) return null;
    this.index += 1;
    return clone(this.stack[this.index]);
  }
}
