import { useEffect, useRef, useState } from "react";
import { getMascot, pickMascotMessage, type MascotId } from "../mascot/mascot";

/** Thời gian thông báo tự đóng (ms). */
export const MASCOT_TOAST_MS = 7000;

/** Thông báo cuối lượt ôn: nhớ hết thì linh vật giơ bảng khen, còn lại thì nói lời động viên. */
export default function MascotToast({
  mascot,
  remembered,
  total,
  onClose,
}: {
  mascot: MascotId;
  remembered: number;
  total: number;
  onClose: () => void;
}) {
  // Chọn lời nhắn một lần, không đổi khi render lại.
  const [message] = useState(() => pickMascotMessage(remembered, total));
  const { emoji, name } = getMascot(mascot);

  // Giữ onClose mới nhất để hẹn giờ chỉ chạy một lần, kể cả khi cha truyền hàm inline.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const timer = window.setTimeout(() => onCloseRef.current(), MASCOT_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className={`mascot-toast${message.perfect ? " perfect" : ""}`} role="status" aria-live="polite">
      <button type="button" className="mascot-toast-close" aria-label="Đóng" onClick={onClose}>
        ×
      </button>
      {message.perfect ? (
        <div className="mascot-sign-scene">
          <div className="mascot-sign">
            <div className="mascot-sign-board">
              <strong className="mascot-title">{message.title}</strong>
              <span className="mascot-text">{message.text}</span>
            </div>
            <div className="mascot-sign-posts" aria-hidden="true">
              <span />
              <span />
            </div>
          </div>
          <span className="mascot-emoji" role="img" aria-label={name}>
            {emoji}
          </span>
        </div>
      ) : (
        <div className="mascot-talk">
          <span className="mascot-emoji" role="img" aria-label={name}>
            {emoji}
          </span>
          <div className="mascot-bubble">
            <strong className="mascot-title">{message.title}</strong>
            <span className="mascot-text">{message.text}</span>
            <span className="mascot-score">
              Nhớ {remembered}/{total} thẻ
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
