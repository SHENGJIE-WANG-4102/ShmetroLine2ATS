/** Per-line presentation data; no simulation rules belong here. */
export interface LineUiData {
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
