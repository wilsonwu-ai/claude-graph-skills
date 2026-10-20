/** Where one loop's shell was last left: see register.ts. */
export type DagGateShellPlace = {
  /** 0 known outside the protected places, 1 inside one (or likely), 2 not known. */
  level: 0 | 1 | 2
  /** Where the shell is: absent when it never moved, null when a computed cd made it unknown. */
  path?: string | null
  /** At level 1, which place: a .dag folder or the frozen dag files. */
  area?: 'person' | 'state' | 'frozen'
}

declare module 'claude-code' {
  interface PluginState {
    'dag-gate': {
      /**
       * Until when (clock ms) the person let the frozen dag files be edited; 0 when locked. Held by the host
       * in memory, so a restart locks them again.
       */
      unlock: number
      /**
       * Per loop (the main loop is `main`, an agent its id): where its shell was last left, so a `cd` in one
       * Bash call is still known in the next.
       */
      shell: Record<string, DagGateShellPlace>
    }
  }
}
