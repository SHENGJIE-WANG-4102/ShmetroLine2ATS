/** Per-line presentation data; no simulation rules belong here. */
export interface LineUiData {
  /** Renderers describe the screen hardware, independently of operating mode. */
  dmiStyle?: 'navyDial' | 'statusGrid';
  pisStyle?: 'landscape' | 'column';
  dmiSpeedWarning?: 'permitted' | 'target';
  tripNumber?: { prefix: string; source: 'duty'; digits: number };
  faultProcedures?: Record<string, string>;
  environmentTitle?: string;
  documentTitle: string;
  bootTitle: string;
  desktopTitle: string;
  headerTitle: string;
  headerSubtitle: string;
  lineNameEn: string;
  pisColorCss: string;
  preferencePrefix: string;
  helpIntro: string;
  helpDmi: string;
  helpScenarios: string;
  helpEnvironment: string;
  holidayNotice: { eve: string; day: string; returning: string; suffix: string };
  stationNameLines: Record<string, [string, string]>;
  transferColors: Record<string, number>;
  overviewWidth: number;
}
