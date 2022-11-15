import { Book, CommonGirlData, getPoseN, Gift, Rarity } from '../data/data';
import {
  ChangePoseResult,
  GameBlessingData,
  GameInventory,
  GameQuests,
  GameWindow,
  GemsData,
  getGameWindow,
  GirlsDataList,
  GirlsSalaryEntry,
  GirlsSalaryList,
  Hero,
  isUnknownObject,
  XPResult
} from '../data/game-data';
import { GameAPI, queue, SalaryDataListener } from '../api/GameAPI';
import { getLevel, getMissingGXP } from '../hooks/girl-xp-hooks';

export const REQUEST_GIRLS = 'request_girls';
export type REQUEST_GAME_DATA = 'request_game_data';
export type RESPONSE_GAME_DATA = 'response_game_data';

export interface HaremDataRequest {
  type: REQUEST_GAME_DATA;
  attribute: keyof GameWindow;
}

export interface HaremDataResponse {
  type: RESPONSE_GAME_DATA;
  attribute: keyof GameWindow;
  gameData: unknown;
}

export namespace HaremMessage {
  export function isRequest(value: unknown): value is HaremDataRequest {
    if (isUnknownObject(value)) {
      const type = value.type;
      return type === 'request_game_data' && value.attribute !== undefined;
    }
    return false;
  }

  export function isResponse(value: unknown): value is HaremDataResponse {
    if (isUnknownObject(value)) {
      const type = value.type;
      return (
        type === 'response_game_data' &&
        value.attribute !== undefined &&
        value.gameData !== undefined
      );
    }
    return false;
  }
}

export class GameAPIImpl implements GameAPI {
  private salaryListeners: SalaryDataListener[] = [];

  constructor(private updateGirl?: (girl: CommonGirlData) => void) {
    this.installRequestsListener();
  }

  setUpdateGirl(updateGirl: (girl: CommonGirlData) => void): void {
    this.updateGirl = updateGirl;
  }

  async getGirls(allowRequest: boolean): Promise<GirlsDataList> {
    // Step 1: Check if the girls data list is already present in the memory.
    // This would only be the case on the harem page.

    const gameGirlsObjects = getGameWindow().girlsDataList as unknown;
    let gameGirls: GirlsDataList | undefined = undefined;
    if (GirlsDataList.isFullHaremData(gameGirlsObjects)) {
      gameGirls = gameGirlsObjects;
      return gameGirls;
    }

    // Step 2: If allowed, send a request to load the harem from the server.
    // This may take a while...

    if (allowRequest) {
      try {
        const haremFrame = await getOrCreateHaremFrame();
        if (!haremFrame.contentWindow) {
          console.error('Found frame, but contentWindow is missing?');
          return Promise.reject(
            'Failed to load harem from the game. Harem Frame not found or not valid.'
          );
        }

        const girlsPromise = new Promise<GirlsDataList>((resolve, reject) => {
          if (!haremFrame || !haremFrame.contentWindow) {
            reject(
              'Harem Frame is no longer available. Cant load girls data...'
            );
            return;
          }
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) {
              haremFrame.contentWindow?.removeEventListener(
                'message',
                messageListener
              );
              console.warn('Frame timeout. Reject girls promise.');
              reject('Timeout');
            }
          }, 30 * 1000 /* 30s Timeout */);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const messageListener = (event: MessageEvent<any>) => {
            if (event.origin === window.location.origin) {
              const data = event.data;
              if (GirlsDataList.isFullHaremData(data)) {
                resolved = true;
                resolve(data);
                // All done. Clear timeout and message listener.
                clearTimeout(timeout);
                window.removeEventListener('message', messageListener);
              } else {
                // Ignore invalid messages. The original game may send
                // unexpected messages. For now, we don't need to explicitly
                // handle invalid data (e.g. rejecting the promise early).
                // The timeout will take care of that.
              }
            }
          };

          window.addEventListener('message', messageListener);
          haremFrame.contentWindow?.postMessage(
            REQUEST_GIRLS,
            window.location.origin
          );
        });
        return girlsPromise;
      } catch (error) {
        console.error('Error while trying to load or get the frame: ', error);
        return Promise.reject(
          'Failed to load harem from the game. Harem Frame not found or not valid.'
        );
      }
    }

    // Step 3: girlsDataList is not already present, and we didn't allow a request.
    // Nothing we can do...

    return Promise.reject('GirlsDataList is undefined');
  }

  async getQuests(allowRequest: boolean): Promise<GameQuests> {
    return this.requestFromHarem('girl_quests', GameQuests.is, allowRequest);
  }

  async getBlessings(): Promise<GameBlessingData> {
    // First, check if the blessings data is already available in memory

    const blessingData = getGameWindow().blessings_data;
    if (GameBlessingData.is(blessingData)) {
      return blessingData;
    }

    // Second, directly fetch the blessings data from the Ajax API

    try {
      const action = {
        action: 'get_girls_blessings'
      };
      const blessings = await this.postRequest(action);
      if (GameBlessingData.is(blessings)) {
        return blessings;
      }
    } catch (fetchError) {
      console.error('Failed to fetch blessings_data. Error: ', fetchError);
      return Promise.reject('Failed to fetch blessings_data.');
    }

    // Third: No luck...

    return Promise.reject('blessings_data is undefined.');
  }

  async collectSalary(girl: CommonGirlData): Promise<boolean> {
    if (!girl.own) {
      return false;
    }
    const params = {
      class: 'Girl',
      id_girl: girl.id,
      action: 'get_salary'
    };
    try {
      // Immediately update the game data; don't wait for the request.
      // Otherwise, UI won't immediately update.
      const salaryData = this.getSalaryData();
      if (salaryData && girl.salaryTime) {
        const gameGirl = salaryData[girl.id];
        if (gameGirl) {
          refreshSalaryManager(gameGirl, girl.salaryTime, salaryData);
        }
      }

      // Then, post the request. The in-game cash value will be updated only
      // in case of success.

      const result = await this.postRequest(params);
      if (isSalaryResult(result)) {
        this.getHero().update('soft_currency', result.money, true);
        return result.success;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  async changePose(girl: CommonGirlData, pose: number): Promise<boolean> {
    if (pose > girl.stars) {
      console.error(
        "Tried to switch to a pose that isn't unlocked or doesn't exist"
      );
      return false;
    }

    const action = {
      action: 'show_specific_girl_grade',
      class: 'Hero',
      id_girl: girl.id,
      girl_grade: pose,
      check_only: 0
    };
    try {
      // Send the change pose request to the server
      const requestResult = this.postRequest(action);

      if (this.updateGirl !== undefined) {
        // While we wait for the result, update the image to what we expect is going to happen...
        girl.currentIcon = pose;
        girl.poseImage = getPoseN(girl.poseImage, pose);
        girl.icon = getPoseN(girl.icon, pose);
        this.updateGirl(girl);

        // Then wait for the proper result, and refresh again if necessary
        const result = await requestResult;

        if (ChangePoseResult.is(result) && result.success) {
          girl.currentIcon = pose;
          girl.poseImage = result.ava;
          girl.icon = result.ico;
          this.updateGirl(girl);

          return result.success;
        }
      }
    } catch (error) {
      console.error('Error while trying to update the girls pose: ', error);
      return Promise.reject([
        'Error while trying to update the girls pose: ',
        error
      ]);
    }

    return false;
  }

  async postRequest(params: HHAction): Promise<unknown> {
    // Throttle the request. Ensure all requests are executed sequentially,
    // to avoid triggerring Error 500.
    return queue(async () => {
      const action = this.paramsToString(params);
      const response = await fetch('/ajax.php', {
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        },
        method: 'POST',
        body: action
      });
      if (response.ok && response.status === 200) {
        const responseJson = await response.json();
        return responseJson;
      } else if (response.status === 403) {
        console.error('!!!ERROR 403!!! Slow down...');
        throw response;
      }
    });
  }

  getSalaryData(): GirlsSalaryList {
    const salaryManager = getGameWindow().GirlSalaryManager;
    const girlsMap = salaryManager.girlsMap;
    const result: GirlsSalaryList = {};
    for (const girlId in girlsMap) {
      const girlObj = girlsMap[girlId];
      if (girlObj.gData) {
        const data = girlObj.gData;
        result[girlId] = data;
      }
    }
    return result;
  }

  paramsToString(params: HHAction): string {
    let result = '';
    let separator = '';
    for (const key of Object.keys(params)) {
      result += `${separator}${key}=${params[key]}`;
      separator = '&';
    }
    return result;
  }

  async getGemsData(allowRequest: boolean): Promise<GemsData> {
    return await this.requestFromHarem(
      'player_gems_amount',
      GemsData.is,
      allowRequest
    );
  }

  async getMarketInventory(allowRequest: boolean): Promise<GameInventory> {
    return this.requestFromMarket(
      'player_inventory',
      GameInventory.is,
      allowRequest
    );
  }

  async useBook(girl: CommonGirlData, book: Book): Promise<void> {
    if (!girl.own) {
      return;
    }

    const missingGXP = getMissingGXP(girl);

    const bookValid =
      girl.level! < girl.maxLevel! &&
      (missingGXP >= book.xp || book.rarity < Rarity.mythic); // Mythic books can't overflow
    // TODO Special case: Mythic book Lv. 350
    if (bookValid) {
      const params = {
        id_girl: girl.id,
        id_item: book.itemId,
        action: 'girl_give_xp'
      };
      this.updateGirlXpStats(girl, book.xp);
      const expectedResult = { ...girl };
      if (this.updateGirl !== undefined) {
        this.updateGirl(girl);
      }
      const result = await this.postRequest(params);
      if (XPResult.is(result) && result.success) {
        if (
          result.xp === expectedResult.currentGXP &&
          result.level === expectedResult.level
        ) {
          // All good, no surprise
          return;
        } else {
          console.warn(
            'Successfully used book, but got unexpected result. Expected: ',
            expectedResult.level,
            expectedResult.currentGXP,
            book.xp,
            'was: ',
            result
          );
        }
      } else {
        console.warn('Failed to use book: ', result);
      }
    } else {
      console.warn("Can't use this book");
    }

    return;
  }

  private updateGirlXpStats(girl: CommonGirlData, addXp: number): void {
    girl.level = Math.min(getLevel(girl, addXp), girl.maxLevel ?? 250);
    girl.currentGXP += addXp;
  }

  async useGift(_girl: CommonGirlData, _gift: Gift): Promise<void> {
    return;
  }
  async maxXP(_girl: CommonGirlData): Promise<void> {
    return;
  }
  async maxAff(_girl: CommonGirlData): Promise<void> {
    return;
  }

  /**
   * Extract data from the harem page.
   * @param attribute The harem property to extract
   * @param typeTester A type tester, to make sure we return a value of the correct type
   * @param allowRequest Whether network requests are allowed. This should be false when requesting directly from the harem.html page,
   * true otherwise (e.g. from the quick-harem on home.html)
   */
  private async requestFromHarem<T>(
    attribute: keyof GameWindow,
    typeTester: (value: unknown) => value is T,
    allowRequest: boolean
  ): Promise<T> {
    return this.requestFromFrame(
      () => getOrCreateHaremFrame(),
      attribute,
      typeTester,
      allowRequest
    );
  }

  /**
   * Extract data from the market page.
   * @param attribute The market property to extract
   * @param typeTester A type tester, to make sure we return a value of the correct type
   * @param allowRequest Whether network requests are allowed. This should be false when requesting directly from the harem.html page,
   * true otherwise (e.g. from the quick-harem on home.html)
   */
  private async requestFromMarket<T>(
    attribute: keyof GameWindow,
    typeTester: (value: unknown) => value is T,
    allowRequest: boolean
  ): Promise<T> {
    return this.requestFromFrame(
      () => getOrCreateMarketFrame(),
      attribute,
      typeTester,
      allowRequest
    );
  }

  /**
   * Extract data from the page in the given frame.
   * @param frameSupplier A function to retrieve the frame
   * @param attribute The page property to extract
   * @param typeTester A type tester, to make sure we return a value of the correct type
   * @param allowRequest Whether network requests are allowed. This should be false when requesting directly from the harem.html page,
   * true otherwise (e.g. from the quick-harem on home.html)
   */
  private async requestFromFrame<T>(
    frameSupplier: () => Promise<HTMLIFrameElement>,
    attribute: keyof GameWindow,
    typeTester: (value: unknown) => value is T,
    allowRequest: boolean
  ): Promise<T> {
    // Step 1: Check if the value is available on the current page
    const gameData = getGameWindow()[attribute] as unknown;
    if (typeTester(gameData)) {
      return gameData;
    }

    // Step 2: If allowed, load/reload the frame, and read the data there
    if (allowRequest) {
      // Request from harem frame
      try {
        const gameFrame = await frameSupplier();
        if (!gameFrame.contentWindow) {
          console.error('Found frame, but contentWindow is missing?');
          return Promise.reject(
            'Failed to load requested data from the game. Frame not found or not valid. Data: ' +
              attribute
          );
        }

        const gameDataPromise = new Promise<T>((resolve, reject) => {
          if (!gameFrame || !gameFrame.contentWindow) {
            reject(
              'Harem Frame is no longer available. Cant load game data...'
            );
            return;
          }
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) {
              gameFrame.contentWindow?.removeEventListener(
                'message',
                messageListener
              );
              console.warn(
                'Frame timeout. Reject game data promise. Attribute: ',
                attribute
              );
              reject('Timeout');
            }
          }, 30 * 1000 /* 30s Timeout */);

          const messageListener = (event: MessageEvent<unknown>) => {
            if (event.origin === window.location.origin) {
              const data = event.data;
              if (HaremMessage.isResponse(data)) {
                if (data.attribute === attribute) {
                  if (typeTester(data.gameData)) {
                    resolved = true;
                    resolve(data.gameData);
                    // All done. Clear timeout and message listener.
                    clearTimeout(timeout);
                    window.removeEventListener('message', messageListener);
                  } else {
                    console.error(
                      'Received a response for our data request, but data type doesnt match. Attribute: ',
                      attribute,
                      'Data: ',
                      data.gameData
                    );
                    // Clear timeout and Reject?
                  }
                } // Else: Ignore harem-reponse for other game attributes
              } // Else: Ignore unrelated message
            }
          };

          window.addEventListener('message', messageListener);
          const requestDataMessage: HaremDataRequest = {
            type: 'request_game_data',
            attribute: attribute
          };
          gameFrame.contentWindow?.postMessage(
            requestDataMessage,
            window.location.origin
          );
        });
        return gameDataPromise;
      } catch (error) {
        console.error('Error while trying to load or get the frame: ', error);
        return Promise.reject(
          'Failed to load gems data from the game. Game Frame not found or not valid.'
        );
      }
    }

    // Step 3: Fail...
    return Promise.reject(
      'Failed to retrieve requested data from the game page: ' + attribute
    );
  }

  /**
   * Original game object "Hero"
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getHero(): Hero {
    return getGameWindow().Hero;
  }

  addSalaryDataListener(listener: SalaryDataListener): void {
    this.salaryListeners.push(listener);
  }

  removeSalaryDataListener(listener: SalaryDataListener): void {
    const index = this.salaryListeners.indexOf(listener);
    if (index >= 0) {
      this.salaryListeners.splice(index, 1);
    }
  }

  private installRequestsListener(): void {
    // Intercept responses to ajax requests. For now, this is used to refresh
    // harem salary data when "Collect all" is used from the home page.
    getGameWindow()
      .$(document)
      .ajaxComplete((event: unknown, request: unknown, settings: unknown) => {
        this.handleRequest(event, request, settings);
      });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleRequest(_event: any, request: any, settings: any): void {
    if (settings.url === '/ajax.php' && settings.type === 'POST') {
      const params = settings.data;
      if (params !== undefined && params.includes('action=get_all_salaries')) {
        if (request.responseJSON && request.responseJSON.girls) {
          const girls = request.responseJSON.girls;
          for (const listener of this.salaryListeners) {
            listener(girls);
          }
        }
      }
    }
  }
}

interface HHAction {
  action: string;
  [key: string]: string | number | boolean;
}

// Last time the frame was requested.
let lastFrameRequest = 0;
// Several APIs may request the frame to read data from it. Typically,
// we'll get several requests in a row, and they'll all resolve successively
// once the frame is loaded. Make sure we don't force a frame refresh for each request.
// Still keep the delay low, so manual refresh can happen without artifical delays.
const FRAME_REQUEST_DELAY = 2000; /* 2 seconds */

/**
 * The GameAPI uses an IFrame to render the harem in the background, then extract
 * girls data from it once it's ready. This function creates or returns the existing frame.
 */
async function getOrCreateHaremFrame(): Promise<HTMLIFrameElement> {
  const refreshFrame = lastFrameRequest + FRAME_REQUEST_DELAY < Date.now();
  lastFrameRequest = Date.now();

  return queue(
    () =>
      new Promise<HTMLIFrameElement>((resolve, reject) => {
        let haremFrame = document.getElementById(
          'harem-loader'
        ) as HTMLIFrameElement;
        if (haremFrame) {
          if (refreshFrame && haremFrame.contentWindow) {
            const initial = Date.now();
            haremFrame.onload = () => {
              const final = Date.now();
              const delay = final - initial;
              console.info('Harem frame reloaded in ', delay, 'ms');
              resolve(haremFrame);
            };
            haremFrame.contentWindow.location.reload();
          } else {
            resolve(haremFrame);
          }
        } else {
          const wrapper = document.getElementById('quick-harem-wrapper');
          if (wrapper) {
            haremFrame = document.createElement('iframe');
            haremFrame.setAttribute('id', 'harem-loader');
            haremFrame.setAttribute('src', 'harem.html');
            haremFrame.setAttribute('style', 'visibility: hidden;');
            wrapper.appendChild(haremFrame);
            const initialLoad = Date.now();
            haremFrame.onload = () => {
              const finalLoad = Date.now();
              const loadDelay = finalLoad - initialLoad;
              console.info('Harem frame loaded in ', loadDelay, 'ms');
              resolve(haremFrame);
            };
          } else {
            reject('#quick-harem-wrapper not found; abort');
          }
        }
      })
  );
}

/**
 * The GameAPI uses an IFrame to render the market in the background, then extract
 * inventory data from it once it's ready. This function creates or returns the existing frame.
 */
async function getOrCreateMarketFrame(): Promise<HTMLIFrameElement> {
  const refreshFrame = lastFrameRequest + FRAME_REQUEST_DELAY < Date.now();
  lastFrameRequest = Date.now();

  return queue(
    () =>
      new Promise<HTMLIFrameElement>((resolve, reject) => {
        let haremFrame = document.getElementById(
          'market-loader'
        ) as HTMLIFrameElement;
        if (haremFrame) {
          if (refreshFrame && haremFrame.contentWindow) {
            const initial = Date.now();
            haremFrame.onload = () => {
              const final = Date.now();
              const delay = final - initial;
              console.info('Market frame reloaded in ', delay, 'ms');
              resolve(haremFrame);
            };
            haremFrame.contentWindow.location.reload();
          } else {
            resolve(haremFrame);
          }
        } else {
          const wrapper = document.getElementById('quick-harem-wrapper');
          if (wrapper) {
            haremFrame = document.createElement('iframe');
            haremFrame.setAttribute('id', 'market-loader');
            haremFrame.setAttribute('src', 'shop.html');
            haremFrame.setAttribute('style', 'visibility: hidden;');
            wrapper.appendChild(haremFrame);
            const initialLoad = Date.now();
            haremFrame.onload = () => {
              const finalLoad = Date.now();
              const loadDelay = finalLoad - initialLoad;
              console.info('Market frame loaded in ', loadDelay, 'ms');
              resolve(haremFrame);
            };
          } else {
            reject('#quick-harem-wrapper not found; abort');
          }
        }
      })
  );
}

interface SalaryResult {
  success: boolean;
  money: number;
  time: number;
}

function isSalaryResult(data: unknown): data is SalaryResult {
  if (isUnknownObject(data)) {
    if (data.success && typeof data['money'] === 'number') {
      return true;
    }
  }
  return false;
}

function refreshSalaryManager(
  girlSalaryEntry: GirlsSalaryEntry,
  salaryTime: number,
  salaryData: GirlsSalaryList
): void {
  // Refresh the salaryManager (Used to update the collectButton when girls are ready,
  // including the Tooltips)
  const salaryManager = getGameWindow().GirlSalaryManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ownedGirls: { [key: string]: any } = {};
  const gameWindow = getGameWindow();

  girlSalaryEntry.pay_in = salaryTime + 10;

  // FIXME: Is there a better way to refresh, relying more heavily
  // on the GirlSalaryManager? Each time we reset the manager, we
  // introduce (minor) delay inconsistencies in the timers.

  for (const girlId in salaryData) {
    ownedGirls[girlId] = new gameWindow.Girl(salaryData[girlId]);
    ownedGirls[girlId]['gId'] = parseInt(girlId, 10);
  }
  salaryManager.init(ownedGirls, true);

  // Refresh the collect all button
  const collectButton = gameWindow.$('#collect_all');
  const salarySum = collectButton.find('.sum');
  const newAmount = Math.max(
    0,
    parseInt(salarySum.attr('amount'), 10) - girlSalaryEntry.salary
  );
  salarySum.attr('amount', newAmount);
  const collectStr = gameWindow.GT.design.harem_collect;
  const amountTxt = gameWindow.number_format_lang(newAmount, 0);
  salarySum.text(collectStr + ' ' + amountTxt);

  gameWindow.Collect.changeDisableBtnState(newAmount <= 0);
}
