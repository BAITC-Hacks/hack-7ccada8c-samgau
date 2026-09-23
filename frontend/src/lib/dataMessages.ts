const messages: Record<string,string> = {
  assumed_replenishment_policy:'Сроки поставки и запас заданы как допущение — проверьте их.',
  ordinary_delivery_too_late_requires_expedite:'Обычная поставка не успеет до дефицита. Рассмотрите ускорение.',
  supplier_seasonality_is_sku_approximation:'Общая сезонность поставщика применена к товару как оценка.',
  synthetic_demo_data:'Синтетические данные для демонстрации.',
  unmapped_category_run_parameters_used:'Для категории использованы общие параметры расчёта.',
  unmapped_category_default_policy:'Для категории пока нет отдельной политики закупок.',
  current_available_stock_missing:'Нет актуального свободного остатка.',
  unit_conversion_missing:'Не подтверждён пересчёт складских единиц в закупочные.',
  order_rules_missing:'Неизвестен минимальный заказ или кратность.',
  incoming_coverage_not_confirmed:'Не подтверждена полнота данных о товарах в пути.',
  insufficient_demand_history:'Недостаточно истории для прогноза спроса.',
  incoming_unit_conversion_missing:'Не подтверждены единицы товара в пути.',
  order_unit_requires_confirmation:'Требуется подтверждение единицы заказа.',
  inventory_conflict_requires_confirmation:'Свободный остаток расходится с остатком за вычетом резервов.',
  inventory_available_conflicts_with_on_hand_minus_reserved:'Свободный остаток расходится с остатком за вычетом резервов.',
  category_requires_manual_confirmation:'Категория требует ручной проверки.',
  stale_inventory_requires_confirmation:'Остаток устарел и требует подтверждения.',
  unknown_order_rules_blocked_transport_defaults_only:'Правило заказа неизвестно. Показанный шаг не разрешает утверждение.',
  seasonality_missing_assumed_flat:'Нет сезонности: использовано равномерное распределение спроса.',
  overdue_shipment_requires_reconciliation:'Дата поступления партии прошла. Уточните её состояние.',
  shipment_after_horizon:'Поставка за пределами горизонта расчёта не уменьшает заказ.',
};
export function dataMessage(value:string) {
  const [code,...detail]=value.split(':');
  return messages[code] ? messages[code]+(detail.length ? ` (${detail.join(':')})` : '') : value;
}
