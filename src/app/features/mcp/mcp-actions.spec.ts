import { describe, expect, it } from 'vitest';
import { ACTIONS } from '../../core/actions/action-catalog';
import { MCP_ACTIONS } from './mcp-actions';

describe('MCP_ACTIONS', () => {
  it('names only catalog actions that act on the view', () => {
    for (const id of MCP_ACTIONS) {
      const action = ACTIONS.find((a) => a.id === id);
      expect(action, id).toBeDefined();
      expect(['Ansicht', 'Navigation', 'Auswahl', 'Tabs', 'Filter']).toContain(action!.group);
    }
  });

  it('leaves out files, clipboard, dialogs and shortcuts', () => {
    for (const id of [
      'OPEN_FILE',
      'EXPORT',
      'COPY_SELECTION',
      'SAVE_WORKSPACE',
      'OPEN_SETTINGS',
      'CLOSE_TAB',
    ]) {
      expect(MCP_ACTIONS as readonly string[]).not.toContain(id);
    }
  });
});
