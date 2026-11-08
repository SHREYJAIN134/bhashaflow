import { createController } from './controller.js';
import { createRemoteConverter } from './converter-remote.js';
import { MSG } from '../shared/messages.js';

// Injected on demand by the popup (activeTab). Guard against double injection.
if (!globalThis.__bhashaflow) {
  const controller = createController({
    root: document.body,
    converter: createRemoteConverter({ send: (message) => chrome.runtime.sendMessage(message) }),
  });
  globalThis.__bhashaflow = controller; // also handy from the DevTools console: __bhashaflow.explain()

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case MSG.TRANSLATE:
        controller.translate(msg.options).then(sendResponse);
        return true; // async response
      case MSG.PAUSE:
        sendResponse(controller.pause());
        break;
      case MSG.RESUME:
        sendResponse(controller.resume());
        break;
      case MSG.STOP:
        sendResponse(controller.stop());
        break;
      case MSG.RESTORE:
        sendResponse(controller.restore());
        break;
      case MSG.STATUS:
        sendResponse(controller.getStatus());
        break;
      case MSG.SET_OBSERVE:
        sendResponse(controller.setObserve(Boolean(msg.on)));
        break;
      case MSG.EXPLAIN:
        sendResponse(controller.explain());
        break;
      default:
    }
    return false;
  });
}
