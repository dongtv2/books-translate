import { useLayoutSettings, contentWidthClass } from '../context/LayoutSettingsContext.jsx';

// Outer frame shared by the top-level pages (Thư viện, Kho từ vựng, Ôn tập,
// Cài đặt) so they all take the same width — the "Độ rộng nội dung" setting.
export default function PageContainer({ className = 'space-y-6', children }) {
  const { settings } = useLayoutSettings();
  return <div className={`mx-auto px-4 py-8 sm:px-8 ${contentWidthClass(settings.contentWidth)} ${className}`}>{children}</div>;
}
