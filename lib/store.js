// Tiny JSON-file persistence for race history. Writes are atomic and batched.
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 5000;

class Store {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'history.json') : null;
    this.history = [];
    this.timer = null;
    if (this.file) {
      try {
        this.history = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!Array.isArray(this.history)) this.history = [];
      } catch (e) {
        this.history = [];
      }
    }
  }

  add(entry) {
    this.history.unshift(entry);
    if (this.history.length > MAX_ENTRIES) this.history.length = MAX_ENTRIES;
    this.scheduleSave();
  }

  list() { return this.history; }

  clear() {
    this.history = [];
    this.scheduleSave();
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.history));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('[history] save failed:', e.message);
    }
  }
}

module.exports = { Store };