import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
  viewChild
} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import {
  NgxExtendedPdfViewerModule,
  NgxExtendedPdfViewerService,
  PageRenderedEvent,
  PageViewModeType,
  pdfDefaultOptions,
  ProgressBarEvent,
  ScrollModeType, SpreadType
} from 'ngx-extended-pdf-viewer';
import {ToastrService} from '@openng/ngx-toastr';
import {take} from 'rxjs';
import {NgbTooltip} from '@ng-bootstrap/ng-bootstrap';
import {DOCUMENT, NgStyle} from '@angular/common';
import {translate, TranslocoDirective} from "@jsverse/transloco";
import {PdfLayoutMode} from "../../../_models/preferences/pdf-layout-mode";
import {PdfScrollMode} from "../../../_models/preferences/pdf-scroll-mode";
import {PdfTheme} from "../../../_models/preferences/pdf-theme";
import {PdfSpreadMode} from "../../../_models/preferences/pdf-spread-mode";
import {PdfScrollModeTypePipe} from "../../_pipe/pdf-scroll-mode.pipe";
import {PdfSpreadTypePipe} from "../../_pipe/pdf-spread-mode.pipe";
import {ReadingProfile} from "../../../_models/preferences/reading-profiles";
import {takeUntilDestroyed} from "@angular/core/rxjs-interop";
import {KeyBindService} from "../../../_services/key-bind.service";
import {KeyBindTarget} from "../../../_models/preferences/preferences";
import {Breakpoint, BreakpointService} from "../../../_services/breakpoint.service";
import {SeriesService} from "../../../_services/series.service";
import {NavService} from "../../../_services/nav.service";
import {BookService} from "../../../book-reader/_services/book.service";
import {ThemeService} from "../../../_services/theme.service";
import {AccountService} from "../../../_services/account.service";
import {CHAPTER_ID_DOESNT_EXIST, ReaderService} from "../../../_services/reader.service";
import {UtilityService} from "../../../shared/_services/utility.service";
import {Chapter} from "../../../_models/chapter";
import {User} from "../../../_models/user/user";

const KEYBIND_TARGETS = [
  {keyBindTarget: KeyBindTarget.OpenHelp},
  {keyBindTarget: KeyBindTarget.Escape},
  {keyBindTarget: KeyBindTarget.FirstPage, description: 'first-page'},
  {keyBindTarget: KeyBindTarget.LastPage, description: 'last-page'},
];

@Component({
  selector: 'app-pdf-reader',
  templateUrl: './pdf-reader.component.html',
  styleUrls: ['./pdf-reader.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgStyle, NgxExtendedPdfViewerModule, NgbTooltip, TranslocoDirective,
    PdfScrollModeTypePipe, PdfSpreadTypePipe]
})
export class PdfReaderComponent implements OnInit, OnDestroy {

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly seriesService = inject(SeriesService);
  private readonly navService = inject(NavService);
  private readonly toastr = inject(ToastrService);
  private readonly bookService = inject(BookService);
  private readonly themeService = inject(ThemeService);
  private readonly cdRef = inject(ChangeDetectorRef);
  public readonly accountService = inject(AccountService);
  public readonly readerService = inject(ReaderService);
  public readonly utilityService = inject(UtilityService);
  public readonly destroyRef = inject(DestroyRef);
  public readonly document = inject(DOCUMENT);
  private readonly keyBindService = inject(KeyBindService);
  private readonly pdfViewerService = inject(NgxExtendedPdfViewerService);
  protected readonly breakpointService = inject(BreakpointService);

  protected readonly ScrollModeType = ScrollModeType;

  readonly container = viewChild.required<ElementRef>('container');

  libraryId!: number;
  seriesId!: number;
  volumeId!: number;
  chapterId!: number;
  chapter!: Chapter;
  user!: User;
  readingProfile!: ReadingProfile;

  /**
   * Reading List id. Defaults to -1.
   */
  readingListId: number = CHAPTER_ID_DOESNT_EXIST;

  /**
   * If this is true, no progress will be saved.
   */
  incognitoMode: boolean = false;

  /**
   * If this is true, chapters will be fetched in the order of a reading list, rather than natural series order.
   */
  readingListMode: boolean = false;

  /**
   * Current Page number
   */
  currentPage: number = 1;
  /**
   * Total pages
   */
  maxPages: number = 1;
  bookTitle: string = '';

  zoomSetting: string | number = 'auto';

  theme: 'dark' | 'light' = 'light';
  themeMap: {[key:string]: {background: string, font: string}} = {
    // Pure black around the pages (the page itself keeps its own colours).
    'dark': {'background': '#000000', 'font': '#d9d9d9'},
    'light': {'background': '#f9f9f9', 'font': '#5a5a5a'}
  }
  backgroundColor: string = this.themeMap[this.theme].background;
  fontColor: string = this.themeMap[this.theme].font;

  /**
   * Invert the rendered PDF pages (white text on black). Remembered per device.
   */
  invertPages: boolean = PdfReaderComponent.loadInvertPages();
  private static readonly invertPagesKey = 'kavita--pdf-reader--invert-pages';

  /**
   * Black margins: paint each page's empty margins black, keeping only the detected
   * content box (text/images + padding) visible. Remembered per device.
   */
  blackMargins: boolean = PdfReaderComponent.loadFlag('kavita--pdf-reader--black-margins');
  /** Content box per page number as fractions of the page (top, right, bottom, left insets). */
  private readonly contentInsets = new Map<number, [number, number, number, number]>();

  /**
   * While the reader is open, pinch gestures zoom the PDF (pdf.js handles them) instead of the
   * whole page, so the toolbar stays in place. Original viewport is restored on destroy.
   */
  private originalViewport: string | null = null;
  private readonly preventGesture = (e: Event) => e.preventDefault();

  /**
   * Tap-to-paginate guards: lifting fingers after a pinch registers as a tap on the edge
   * zones, and while zoomed in the edges should pan rather than turn pages.
   */
  private lastMultiTouchAt = 0;
  private fitZoomFactor: number | null = null;
  isZoomedIn = false;

  /**
   * True if Preferences.DataSaver is true
   */
  disableLoadingIndicator = computed(() => this.accountService.userPreferences()?.dataSaver);
  isLoading: boolean = true;
  /**
   * How much of the current document is loaded
   */
  loadPercent: number = 0;
  scrollbarNeeded = false;

  pageLayoutMode: PageViewModeType = 'multiple';
  scrollMode: ScrollModeType = ScrollModeType.vertical;
  spreadMode: SpreadType = 'off';
  isSearchOpen: boolean = false;

  canDownload = computed(() =>
    this.accountService.hasDownloadRole()
  );

  constructor() {
      this.navService.hideNavBar();
      this.themeService.clearThemes();
      this.navService.hideSideNav();

      this.keyBindService.registerListener(
        this.destroyRef,
        (e) => {
          switch (e.target) {
            case KeyBindTarget.Escape:
              this.closeReader();
              break;
            case KeyBindTarget.FirstPage:
              this.currentPage = 0;
              this.cdRef.markForCheck();
              break;
            case KeyBindTarget.LastPage:
              this.currentPage = this.maxPages;
              this.cdRef.markForCheck();
              break;
            case KeyBindTarget.OpenHelp:
              this.openShortcutModal();
          }

        },
        KEYBIND_TARGETS.map(k => k.keyBindTarget as KeyBindTarget),
      );

      effect(() => {
        const prefs = this.accountService.userPreferences();
        if (prefs) {
          pdfDefaultOptions.disableAutoFetch = prefs.dataSaver;
          this.cdRef.markForCheck();
        }
      });
  }

  @HostListener('window:resize', ['$event'])
  @HostListener('window:orientationchange', ['$event'])
  onResize(event: Event){
    // Update the window Height
    this.calcScrollbarNeeded();
  }

  private lockBrowserZoom() {
    const meta = this.document.querySelector('meta[name="viewport"]');
    if (meta) {
      this.originalViewport = meta.getAttribute('content');
      meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
    }
    // iOS Safari ignores user-scalable=no; its own pinch gesture has to be cancelled instead.
    this.document.addEventListener('gesturestart', this.preventGesture, { passive: false });
    this.document.addEventListener('gesturechange', this.preventGesture, { passive: false });
  }

  private unlockBrowserZoom() {
    const meta = this.document.querySelector('meta[name="viewport"]');
    if (meta && this.originalViewport !== null) {
      meta.setAttribute('content', this.originalViewport);
    }
    this.document.removeEventListener('gesturestart', this.preventGesture);
    this.document.removeEventListener('gesturechange', this.preventGesture);
  }

  ngOnDestroy(): void {
    this.unlockBrowserZoom();
    this.themeService.currentTheme$.pipe(take(1)).subscribe(theme => {
      this.themeService.setTheme(theme.name);
    });

    this.navService.showNavBar();
    this.navService.showSideNav();
    this.readerService.disableWakeLock();

    window.removeEventListener('keydown', this.downloadHandler, { capture: true });
  }

  ngOnInit(): void {
    this.lockBrowserZoom();
    const libraryId = this.route.snapshot.paramMap.get('libraryId');
    const seriesId = this.route.snapshot.paramMap.get('seriesId');
    const chapterId = this.route.snapshot.paramMap.get('chapterId');

    if (libraryId === null || seriesId === null || chapterId === null) {
      this.router.navigateByUrl('/home');
      return;
    }

    this.libraryId = parseInt(libraryId, 10);
    this.seriesId = parseInt(seriesId, 10);
    this.chapterId = parseInt(chapterId, 10);
    this.incognitoMode = this.route.snapshot.queryParamMap.get('incognitoMode') === 'true';

    this.route.data.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(data => {
      this.readingProfile = data['readingProfile'];
      if (this.readingProfile == null) {
        this.router.navigateByUrl('/home');
        return;
      }
      this.setupReaderSettings();
      this.cdRef.markForCheck();
    });


    const readingListId = this.route.snapshot.queryParamMap.get('readingListId');
    if (readingListId != null) {
      this.readingListMode = true;
      this.readingListId = parseInt(readingListId, 10);
    }

    this.cdRef.markForCheck();

    window.addEventListener('keydown', this.downloadHandler, { capture: true });

    this.init();
  }

  private downloadHandler = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.key.toLowerCase() === 's') {
      if (!this.accountService.hasDownloadRole()) {
        event.preventDefault();
        event.stopImmediatePropagation(); // Stops ALL other handlers
      }
    }
  };


  calcScrollbarNeeded() {
    const viewContainer = this.document.querySelector('#viewerContainer');
    if (viewContainer == null) return;
    this.scrollbarNeeded = viewContainer.scrollHeight > this.container()?.nativeElement?.clientHeight;
    this.cdRef.markForCheck();
  }

  convertPdfLayoutMode(mode: PdfLayoutMode) {
    switch (mode) {
      case PdfLayoutMode.Multiple:
        return 'multiple';
      case PdfLayoutMode.Single:
        return 'single';
      case PdfLayoutMode.Book:
        return 'book';
      case PdfLayoutMode.InfiniteScroll:
        return 'infinite-scroll';

    }
  }

  convertPdfScrollMode(mode: PdfScrollMode) {
    switch (mode) {
      case PdfScrollMode.Vertical:
        return ScrollModeType.vertical;
      case PdfScrollMode.Horizontal:
        return ScrollModeType.horizontal;
      case PdfScrollMode.Wrapped:
        return ScrollModeType.wrapped;
      case PdfScrollMode.Page:
        return ScrollModeType.page;
    }
  }

  convertPdfSpreadMode(mode: PdfSpreadMode): SpreadType {
    switch (mode) {
      case PdfSpreadMode.None:
        return 'off' as SpreadType;
      case PdfSpreadMode.Odd:
        return 'odd' as SpreadType;
      case PdfSpreadMode.Even:
        return 'even' as SpreadType;
    }
  }

  convertPdfTheme(theme: PdfTheme) {
    switch (theme) {
      case PdfTheme.Dark:
        return 'dark';
      case PdfTheme.Light:
        return 'light';
    }
  }

  setupReaderSettings() {
    this.pageLayoutMode = this.convertPdfLayoutMode(PdfLayoutMode.Multiple);
    this.scrollMode = this.convertPdfScrollMode(this.readingProfile.pdfScrollMode || PdfScrollMode.Vertical);
    this.spreadMode = this.convertPdfSpreadMode(this.readingProfile.pdfSpreadMode || PdfSpreadMode.None);
    this.theme = this.convertPdfTheme(this.readingProfile.pdfTheme || PdfTheme.Dark);
  }

  init() {
    this.backgroundColor = this.themeMap[this.theme].background;
    this.fontColor = this.themeMap[this.theme].font; // TODO: Move this to an observable or something

    this.calcScrollbarNeeded();

    this.bookService.getBookInfo(this.chapterId).subscribe(info => {
      this.volumeId = info.volumeId;
      this.bookTitle = info.bookTitle;
      this.cdRef.markForCheck();
    });

    this.readerService.getProgress(this.chapterId).subscribe(progress => {
      this.currentPage = progress.pageNum || 1;
      this.cdRef.markForCheck();
    });

    this.seriesService.getChapter(this.chapterId).subscribe(chapter => {
      this.maxPages = chapter.pages;

      if (this.currentPage >= this.maxPages) {
        this.currentPage = this.maxPages - 1;
        // Don't save progress on first load to avoid session creation, wait for a page change event
      }
      this.cdRef.markForCheck();
    });
    setTimeout(() => this.readerService.enableWakeLock(this.container().nativeElement), 1000);
  }

  /**
   * Turns off Incognito mode. This can only happen once if the user clicks the icon. This will modify URL state
   */
   turnOffIncognito() {
    this.incognitoMode = false;
    const newRoute = this.readerService.getNextChapterUrl(this.router.url, this.chapterId, this.incognitoMode, this.readingListMode, this.readingListId);
    window.history.replaceState({}, '', newRoute);
    this.toastr.info(translate('toasts.incognito-off'));
    this.saveProgress();
    this.cdRef.markForCheck();
  }

  private static loadFlag(key: string): boolean {
    try {
      return localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  }

  toggleBlackMargins() {
    this.blackMargins = !this.blackMargins;
    try {
      localStorage.setItem('kavita--pdf-reader--black-margins', String(this.blackMargins));
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this session.
    }
    const root = this.container()?.nativeElement as HTMLElement | undefined;
    const pages = root?.querySelectorAll<HTMLDivElement>('.pdfViewer .page') ?? [];
    pages.forEach((page: HTMLDivElement) => {
      const pageNumber = Number(page.dataset['pageNumber']);
      if (this.blackMargins) {
        this.applyBlackMargins(page, pageNumber);
      } else {
        this.clearBlackMargins(page);
      }
    });
    this.cdRef.markForCheck();
  }

  onPageRendered(event: PageRenderedEvent) {
    if (!this.blackMargins) return;
    this.applyBlackMargins(event.source.div, event.pageNumber, event.source.canvas);
  }

  private applyBlackMargins(page: HTMLDivElement, pageNumber: number, canvas?: HTMLCanvasElement) {
    const wrapper = page.querySelector<HTMLElement>('.canvasWrapper');
    if (!wrapper) return;
    let insets = this.contentInsets.get(pageNumber);
    if (!insets) {
      const source = canvas ?? wrapper.querySelector('canvas');
      if (!source || !source.width) return;
      const detected = PdfReaderComponent.detectContentInsets(source);
      if (!detected) return;
      insets = detected;
      this.contentInsets.set(pageNumber, insets);
    }
    const [top, right, bottom, left] = insets.map(v => `${(v * 100).toFixed(2)}%`);
    // Clip the wrapper (it holds both the page canvas and pdf.js' zoomed detail canvas);
    // the black page background shows through outside the content box.
    wrapper.style.clipPath = `inset(${top} ${right} ${bottom} ${left})`;
    page.style.backgroundColor = '#000';
  }

  private clearBlackMargins(page: HTMLDivElement) {
    const wrapper = page.querySelector<HTMLElement>('.canvasWrapper');
    if (wrapper) wrapper.style.clipPath = '';
    page.style.backgroundColor = '';
  }

  /**
   * Finds the bounding box of "ink" (non-background pixels) on a downscaled copy of the page.
   * Rows/columns need a few dark pixels to count, so stray specks don't widen the box.
   */
  private static detectContentInsets(canvas: HTMLCanvasElement): [number, number, number, number] | null {
    const width = 300;
    const height = Math.max(1, Math.round(canvas.height * width / canvas.width));
    const probe = document.createElement('canvas');
    probe.width = width;
    probe.height = height;
    const ctx = probe.getContext('2d', {willReadFrequently: true});
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(canvas, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;

    const rows = new Uint16Array(height);
    const cols = new Uint16Array(width);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (Math.min(data[i], data[i + 1], data[i + 2]) < 200) {
          rows[y]++;
          cols[x]++;
        }
      }
    }
    const minRow = 2, minCol = 2;
    let top = rows.findIndex(n => n >= minRow);
    if (top < 0) return null; // blank page: leave it alone
    let bottom = height - 1 - [...rows].reverse().findIndex(n => n >= minRow);
    let left = cols.findIndex(n => n >= minCol);
    let right = width - 1 - [...cols].reverse().findIndex(n => n >= minCol);

    const padX = Math.round(width * 0.02), padY = Math.round(height * 0.015);
    top = Math.max(0, top - padY);
    bottom = Math.min(height - 1, bottom + padY);
    left = Math.max(0, left - padX);
    right = Math.min(width - 1, right + padX);
    return [top / height, (width - 1 - right) / width, (height - 1 - bottom) / height, left / width];
  }

  private static loadInvertPages(): boolean {
    try {
      return localStorage.getItem(PdfReaderComponent.invertPagesKey) === 'true';
    } catch {
      return false;
    }
  }

  toggleInvertPages() {
    this.invertPages = !this.invertPages;
    try {
      localStorage.setItem(PdfReaderComponent.invertPagesKey, String(this.invertPages));
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this session.
    }
    this.cdRef.markForCheck();
  }

  toggleTheme() {
    if (this.theme === 'dark') {
      this.theme = 'light';
    } else {
      this.theme = 'dark';
    }
    this.backgroundColor = this.themeMap[this.theme].background;
    this.fontColor = this.themeMap[this.theme].font;
    this.cdRef.markForCheck();
  }

  toggleScrollMode() {
    const options: Array<ScrollModeType> = [ScrollModeType.vertical, ScrollModeType.horizontal, ScrollModeType.page];
    let index = options.indexOf(this.scrollMode) + 1;
    if (index >= options.length) index = 0;
    this.scrollMode = options[index];

    this.calcScrollbarNeeded();
    const currPage = this.currentPage;
    this.cdRef.markForCheck();

    setTimeout(() => {
      this.currentPage = currPage;
      this.cdRef.markForCheck();
    }, 100);
  }

  toggleSpreadMode() {
     const options: Array<SpreadType> = ['off', 'odd', 'even'];
     let index = options.indexOf(this.spreadMode) + 1;
     if (index >= options.length) index = 0;
     this.spreadMode = options[index];


    this.cdRef.markForCheck();
  }

  toggleBookPageMode() {
    if (this.pageLayoutMode === 'book') {
      this.pageLayoutMode = 'multiple';
    } else {
      if (this.breakpointService.activeBreakpoint() < Breakpoint.Tablet) {
        this.toastr.info(translate('toasts.pdf-book-mode-screen-size'));
        return;
      }
      this.pageLayoutMode = 'book';
      // If the fit is automatic, let's adjust to 100% to ensure it renders correctly (can't do this, but it doesn't always happen)
    }
    this.cdRef.markForCheck();
  }

  saveProgress() {
    if (this.incognitoMode) return;
    this.readerService.saveProgress(this.libraryId, this.seriesId, this.volumeId, this.chapterId, this.currentPage).subscribe();
  }

  closeReader() {
     this.readerService.closeShortCutModal();
     this.readerService.closeReader(this.libraryId, this.seriesId, this.chapterId, this.readingListMode, this.readingListId);
  }

  openShortcutModal() {
     this.readerService.openShortcutModal(KEYBIND_TARGETS);
  }

  updateLoading(state: boolean) {
    this.isLoading = state;
    this.cdRef.markForCheck();
  }

  updateLoadProgress(event: ProgressBarEvent) {
    this.loadPercent = event.percent;
    this.cdRef.markForCheck();
  }

  updateHandTool(event: any) {
     console.log('event.tool', event);
  }

  updateSearchOpen(event: boolean) {
     this.isSearchOpen = event;
     this.cdRef.markForCheck();
  }

  /**
   * Hands the open PDF to the device: opens the share sheet where the browser allows it
   * (secure contexts), otherwise downloads the file so it can be shared from Files/Downloads.
   */
  async sharePdf() {
    const blob = await this.pdfViewerService.getCurrentDocumentAsBlob();
    if (!blob) {
      this.toastr.error(translate('pdf-reader.share-failed'));
      return;
    }
    const safeTitle = (this.bookTitle || 'book').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const file = new File([blob], `${safeTitle}.pdf`, {type: 'application/pdf'});

    if (navigator.canShare?.({files: [file]})) {
      try {
        await navigator.share({files: [file], title: this.bookTitle});
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return; // user closed the share sheet
      }
    }

    const url = URL.createObjectURL(file);
    const link = this.document.createElement('a');
    link.href = url;
    link.download = file.name;
    this.document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  onTouch(event: TouchEvent) {
    if (event.touches.length > 1) this.lastMultiTouchAt = Date.now();
  }

  onZoomFactor(factor: number) {
    // Named zoom modes ('auto', 'page-fit', …) define the "not zoomed" baseline.
    if (typeof this.zoomSetting === 'string' || this.fitZoomFactor === null) {
      this.fitZoomFactor = factor;
    }
    const zoomed = factor > (this.fitZoomFactor ?? factor) * 1.05;
    if (zoomed !== this.isZoomedIn) {
      this.isZoomedIn = zoomed;
      this.cdRef.markForCheck();
    }
  }

  private recentlyPinched() {
    return Date.now() - this.lastMultiTouchAt < 700;
  }

  tapPrevPage() {
    if (this.isZoomedIn || this.recentlyPinched()) return;
    this.prevPage();
  }

  tapNextPage() {
    if (this.isZoomedIn || this.recentlyPinched()) return;
    this.nextPage();
  }

  prevPage() {
     this.currentPage--;
     if (this.currentPage < 0) this.currentPage = 0;
     this.cdRef.markForCheck();
  }

  nextPage() {
    this.currentPage++;
    if (this.currentPage > this.maxPages) this.currentPage = this.maxPages;
    this.cdRef.markForCheck();
  }


  protected readonly Breakpoint = Breakpoint;
}
