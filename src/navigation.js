export function navigationItems(role, hasCourse) {
  const items = [['attendance', 'grid', 'נוכחות']];
  if (hasCourse) {
    items.push(['roster', 'people', 'רשימת סטודנטים']);
    if (role === 'admin') items.push(['audit', 'clock', 'יומן פעילות']);
    items.push(['settings', 'settings', 'הגדרות והרשאות']);
  } else if (role === 'admin') {
    items.push(['settings', 'settings', 'ניהול הרשאות מרצים']);
  }
  return items;
}
