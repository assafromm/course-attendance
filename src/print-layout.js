export const SLIPS_PER_PAGE = 20;
export function slipPages(slips) {
  return Array.from({ length: Math.ceil(slips.length / SLIPS_PER_PAGE) }, (_, index) =>
    slips.slice(index * SLIPS_PER_PAGE, (index + 1) * SLIPS_PER_PAGE));
}
