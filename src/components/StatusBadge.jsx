import { Tag } from './ui.jsx';

export const STATUS_TONES = {
  'Thành thạo': 'ok',
  'Đang học': 'warn',
  'Cần ôn gấp': 'flag',
};

export default function StatusBadge({ status }) {
  return <Tag tone={STATUS_TONES[status] || 'neutral'}>{status}</Tag>;
}
