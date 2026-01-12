import type { ToastType } from "../types";
import "./ToastStack.css";

type ToastItem = { id: number; type: ToastType; message: string; closing?: boolean };

type ToastStackProps = {
  toasts: ToastItem[];
};

export function ToastStack({ toasts }: ToastStackProps) {
  if (!toasts.length) return null;

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div
          className={`toast ${toast.type}${toast.closing ? " closing" : ""}`}
          key={toast.id}
          data-qa={`qa:toast:${toast.type}`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
