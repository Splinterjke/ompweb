interface WindowNotificationLike {
  onclick: Notification["onclick"];
  close: () => void;
}

export interface CompletionNotificationEnvironment {
  createNotification: (title: string, options?: NotificationOptions) => WindowNotificationLike;
}

/**
 * Core browser-notification helper: create a notification whose click closes
 * it and fires `onClick` (when provided). Returns false when the platform
 * refused the notification (no permission / no Notification API). Both the
 * built-in completion notification and the chat event actions'
 * notification-type actions route through this.
 */
export function showBrowserNotification(
  title: string,
  body: string,
  onClick?: () => void,
  environment: CompletionNotificationEnvironment = { createNotification: (nextTitle, options) => new Notification(nextTitle, options) },
): boolean {
  try {
    const notification = environment.createNotification(title, { body });
    if (onClick) {
      notification.onclick = () => {
        notification.close();
        onClick();
      };
    }
    return true;
  } catch {
    return false;
  }
}

/** Built-in completion notification (kept as a thin wrapper for the existing
 * callers and their tests). */
export function showCompletionNotification(
  title: string,
  body: string,
  onClick: () => void,
  environment?: CompletionNotificationEnvironment,
): boolean {
  return showBrowserNotification(title, body, onClick, environment);
}
