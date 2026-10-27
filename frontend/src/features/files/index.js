/**
 * PairPort File Transfer Feature Module
 * Public interface for file sharing UI, status indicators, and controller coordination.
 */

export {
  renderRecipientSelector,
  renderActiveTransferPanel,
  renderFilesList,
  renderFileHubColumn,
  updateFilesUI,
} from './files-ui.js';

export {
  initFiles,
} from './files-controller.js';
