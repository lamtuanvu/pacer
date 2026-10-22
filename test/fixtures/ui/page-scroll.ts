import { onPageScroll, pageScrollY, resetDesktopPageScroll, scrollPageTo } from "../../../app/src/shell/page-scroll";

Object.assign(window, { pageScrollFixture: { onPageScroll, pageScrollY, resetDesktopPageScroll, scrollPageTo } });
