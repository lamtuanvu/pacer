import { capturePosition, restorePosition } from "../../../app/src/workspace/position";
const canvas = () => document.querySelector<HTMLElement>('.pc-work')!;
export const pageScrollY = () => canvas().scrollTop;
export const scrollPageTo = (top: number) => restorePosition({ scroll: { page: { scrollTop: top, scrollLeft: 0 } } }, [['page', canvas()]], () => {});
export const resetDesktopPageScroll = () => scrollPageTo(0);
export const onPageScroll = (listener: () => void) => { canvas().addEventListener('scroll', listener); return () => canvas().removeEventListener('scroll', listener); };
Object.assign(window, { pageScrollFixture: { onPageScroll, pageScrollY, resetDesktopPageScroll, scrollPageTo, capturePosition } });
