import { Book, CommonGirlData, getPoseN, Gift } from '../data/data';
import {
  GameBlessingData,
  GameInventory,
  GameQuests,
  GemsData,
  GemsEntry,
  GirlsDataList,
  GirlsSalaryList
} from '../data/game-data';
import { GameAPI, queue, SalaryDataListener } from '../api/GameAPI';
import girls from './girlsdatalist-full.json';
import blessings from './blessings-full.json';
import quests from './quests-full.json';
import inventory from './inventory.json';
// const girls = {};
// const blessings = { active: [], upcoming: [] };
// const quests = {};
// const inventory = {gift: [], potion: []};

const MOCK_DELAY = 500;

/**
 * Mock implementation of the GameAPI, used to run the game-extension
 * locally (outside of the game), with pre-stored data. Actions are either
 * no-op, or will only modify the data in memory. Actions will never affect
 * the real game.
 */
export class MockGameAPI implements GameAPI {
  constructor(private updateGirl?: (girl: CommonGirlData) => void) {}

  setUpdateGirl(updateGirl: (girl: CommonGirlData) => void): void {
    this.updateGirl = updateGirl;
  }

  async getGirls(): Promise<GirlsDataList> {
    return new Promise((resolve, _reject) => {
      setTimeout(() => {
        resolve({ ...girls } as unknown as GirlsDataList); // Trust me bro.
      }, MOCK_DELAY);
    });
  }

  async getBlessings(): Promise<GameBlessingData> {
    return new Promise((resolve, _reject) => {
      setTimeout(() => {
        resolve({ ...blessings });
      }, MOCK_DELAY + 200);
    });
  }

  async getQuests(): Promise<GameQuests> {
    return new Promise((resolve, _reject) => {
      setTimeout(() => {
        resolve({ ...quests } as unknown as GameQuests);
      }, MOCK_DELAY + 400);
    });
  }

  async collectSalary(girl: CommonGirlData): Promise<boolean> {
    try {
      const result = await this.mockRequest(() => {
        return {
          success: true,
          money: 850,
          time: girl.salaryTime
        };
      }, Math.random() < 0.5);
      return result.success;
    } catch (error) {
      console.warn('Failed to collect salary. Reason: ', error);
      return false;
    }
  }

  async changePose(girl: CommonGirlData, pose: number): Promise<boolean> {
    if (pose > girl.stars) {
      console.error(
        "Tried to switch to a pose that isn't unlocked or doesn't exist"
      );
      return false;
    }
    girl.currentIcon = pose;
    girl.poseImage = getPoseN(girl.poseImage, pose);
    girl.icon = getPoseN(girl.icon, pose);
    if (this.updateGirl !== undefined) {
      this.updateGirl(girl);
    }
    return true;
  }

  getSalaryData(): GirlsSalaryList {
    return {};
  }

  async getGemsData(): Promise<GemsData> {
    function entry(amount: number): GemsEntry {
      return {
        amount: String(amount),
        gem: {
          flavor: 'Mock',
          ico: 'none',
          type: '??'
        }
      };
    }
    return new Promise((resolve) => {
      setTimeout(
        () =>
          resolve({
            darkness: entry(1000),
            fire: entry(49555),
            light: entry(15000),
            nature: entry(2750),
            psychic: entry(42),
            stone: entry(12500),
            sun: entry(9001),
            water: entry(30000 + Math.ceil(Math.random() * 69999))
          }),
        100
      );
    });
  }

  async getMarketInventory(_allowRequest: boolean): Promise<GameInventory> {
    return new Promise((resolve, _reject) => {
      setTimeout(() => {
        resolve({ ...inventory } as GameInventory);
      }, MOCK_DELAY + 550);
    });
  }

  async useBook(girl: CommonGirlData, book: Book): Promise<void> {
    console.log(
      'Use book ',
      book.label,
      ' ',
      book.xp + ' XP',
      'on girl',
      girl.name
    );
    return;
  }

  async useGift(girl: CommonGirlData, gift: Gift): Promise<void> {
    console.log(
      'Use gift ',
      gift.label,
      ' ',
      gift.aff + ' Aff',
      'on girl',
      girl.name
    );
    return;
  }
  async maxXP(_girl: CommonGirlData): Promise<void> {
    return;
  }
  async maxAff(_girl: CommonGirlData): Promise<void> {
    return;
  }

  /**
   * Mock a request execution that takes 100ms to execute, then
   * returns the result.
   *
   * @param result A provider for the result to be returned upon request success
   * @param success A boolean indicating if the mock request should be successful. If false, the promise will be rejected.
   */
  private async mockRequest<T>(result: () => T, success = true): Promise<T> {
    return queue(
      () =>
        new Promise<T>((resolve, reject) => {
          setTimeout(() => {
            if (success) {
              resolve(result());
            } else {
              reject('Mock Error');
            }
          }, 100);
        })
    );
  }

  addSalaryDataListener(_listener: SalaryDataListener): void {
    // Not supported in mock
  }

  removeSalaryDataListener(_listener: SalaryDataListener): void {
    // Not supported in mock
  }
}
