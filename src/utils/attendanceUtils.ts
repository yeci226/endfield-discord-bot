import {
  executeAttendance,
  formatSkGameRole,
  getAttendanceList,
} from "./skportApi";
import { Logger } from "./Logger";

const logger = new Logger("AttendanceUtils");

/**
 * Processes attendance for a single game role.
 * Consolidates status checking and execution.
 */
export async function processRoleAttendance(
  role: any,
  gameId: number,
  cookie: string,
  lang: string,
  cred: string,
  salt: string,
  isClaim: boolean,
  tr: any,
  options: any = {},
) {
  const gameRoleStr = formatSkGameRole(
    gameId,
    String(role.roleId || ""),
    String(role.serverId || ""),
  );

  try {
    if (gameId !== 1 && gameId !== 3) {
      return {
        roleId: role.roleId,
        nickname: role.nickname,
        level: role.level,
        error: true,
        message: tr("Error") || "Unsupported game for attendance",
      };
    }

    const res = await getAttendanceList(
      gameId,
      String(role.roleId || ""),
      gameRoleStr,
      cookie,
      lang,
      cred,
      salt,
      options,
    );
    let status = res?.data;

    if (!status) {
      return {
        roleId: role.roleId,
        nickname: role.nickname,
        level: role.level,
        error: true,
        message:
          res?.code === 10000
            ? tr("TokenExpired")
            : tr("Error") || "Status request failed",
      };
    }

    let signedNow = false;
    let claimResult = null;

    if (isClaim && !status.hasToday) {
      claimResult = await executeAttendance(
        gameId,
        String(role.roleId || ""),
        gameRoleStr,
        cookie,
        lang,
        cred,
        salt,
        options,
      );

      if (
        claimResult &&
        (claimResult.code === 0 || claimResult.code === 10001)
      ) {
        signedNow = claimResult.code === 0;

        if (claimResult.code === 0 && claimResult.data?.awardIds) {
          status.awardIds = claimResult.data.awardIds;
          status.hasToday = true;
          const availableEntry = status.calendar.find((d: any) => d.available);
          if (availableEntry) {
            availableEntry.done = true;
            availableEntry.available = false;
          }
          if (claimResult.data.resourceInfoMap) {
            status.resourceInfoMap = {
              ...status.resourceInfoMap,
              ...claimResult.data.resourceInfoMap,
            };
          }
        } else {
          const newStatus = await getAttendanceList(
            gameId,
            String(role.roleId || ""),
            gameRoleStr,
            cookie,
            lang,
            cred,
            salt,
            options,
          );
          if (newStatus?.data) status = newStatus.data;
        }
      }
    }

    const calendar = Array.isArray(status.calendar) ? status.calendar : [];
    const resourceInfoMap = status.resourceInfoMap || {};
    const awardIds = Array.isArray(status.awardIds) ? status.awardIds : [];

    const getEntryResourceId = (entry: any): string => {
      return String(entry?.awardId || entry?.resourceId || "");
    };

    const getEntryCount = (entry: any): number | undefined => {
      const raw = Number(entry?.count);
      return Number.isFinite(raw) && raw > 0 ? raw : undefined;
    };

    const getRewardText = (resource: any, fallbackCount?: number): string => {
      if (!resource) return tr("None") || "None";
      const count =
        Number.isFinite(Number(fallbackCount)) && Number(fallbackCount) > 0
          ? Number(fallbackCount)
          : Number(resource.count || 0);
      return count > 0 ? `${resource.name} x${count}` : resource.name;
    };

    const totalDays = calendar.filter((d) => d.done).length;
    const calendarTotalDays = calendar.length;

    let rewards: string[] = [];
    let rewardIcon = "";

    if (awardIds.length > 0) {
      for (const award of awardIds) {
        const resource = resourceInfoMap?.[award.id];
        if (resource) {
          if (!rewardIcon) rewardIcon = resource.icon;
          rewards.push(getRewardText(resource, getEntryCount(award)));
        }
      }
    }

    if (rewards.length === 0) {
      const todayReward =
        calendar.find((r) => r.available) ||
        [...calendar].reverse().find((r) => r.done);

      if (todayReward) {
        const resInfo = resourceInfoMap?.[getEntryResourceId(todayReward)];
        if (resInfo) {
          rewards.push(getRewardText(resInfo, getEntryCount(todayReward)));
          rewardIcon = resInfo.icon;
        }
      }
    }

    const rewardName =
      rewards.length > 0 ? rewards.join("\n") : tr("None") || "None";

    const availableIndex = calendar.findIndex((r) => r.available);
    const firstUndoneIndex = calendar.findIndex((r) => !r.done);
    const lastDoneIndex = [...calendar].reverse().findIndex((r) => r.done);
    const resolvedLastDoneIndex =
      lastDoneIndex >= 0 ? calendar.length - 1 - lastDoneIndex : -1;

    const currentIndex =
      status.hasToday || signedNow
        ? resolvedLastDoneIndex
        : availableIndex >= 0
          ? availableIndex
          : firstUndoneIndex >= 0
            ? firstUndoneIndex
            : resolvedLastDoneIndex;

    const currentRewardEntry =
      currentIndex >= 0 ? calendar[currentIndex] : null;

    const todayAnchorIndex =
      availableIndex >= 0
        ? availableIndex
        : status.hasToday || signedNow
          ? currentIndex
          : firstUndoneIndex >= 0
            ? firstUndoneIndex
            : resolvedLastDoneIndex;

    const checkedDaysThisMonth =
      todayAnchorIndex >= 0 ? todayAnchorIndex + 1 : 0;
    const missedDaysThisMonth =
      todayAnchorIndex > 0
        ? calendar.slice(0, todayAnchorIndex).filter((d) => !d.done).length
        : 0;

    const yesterdayRewardEntry =
      currentIndex > 0 ? calendar[currentIndex - 1] : null;

    const currentResource = currentRewardEntry
      ? resourceInfoMap?.[getEntryResourceId(currentRewardEntry)]
      : null;

    const todayReward = {
      name: currentResource
        ? getRewardText(currentResource, getEntryCount(currentRewardEntry))
        : rewardName,
      icon: currentResource?.icon || rewardIcon,
      resourceId: getEntryResourceId(currentRewardEntry),
      done: !!(status.hasToday || signedNow),
    };

    const yesterdayResource = yesterdayRewardEntry
      ? resourceInfoMap?.[getEntryResourceId(yesterdayRewardEntry)]
      : null;

    const yesterdayReward = {
      name: yesterdayResource
        ? getRewardText(yesterdayResource, getEntryCount(yesterdayRewardEntry))
        : tr("None") || "None",
      icon: yesterdayResource?.icon || "",
      resourceId: getEntryResourceId(yesterdayRewardEntry),
      done: !!yesterdayRewardEntry?.done,
    };

    const nextRewardsRaw = calendar
      .slice(currentIndex + 1, currentIndex + 4)
      .map((dayReward) => {
        const rewardId = getEntryResourceId(dayReward);
        const reward = resourceInfoMap?.[rewardId];
        if (!reward) {
          return { name: tr("None") || "None", icon: "", resourceId: rewardId };
        }
        return {
          name: getRewardText(reward, getEntryCount(dayReward)),
          icon: reward.icon,
          resourceId: rewardId,
        };
      });

    const nextRewards = Array.from(
      { length: 3 },
      (_, i) => nextRewardsRaw[i] ?? { name: "-", icon: "", endOfPeriod: true },
    );

    let firstRewardName = "";
    const firstList = Array.isArray(status.first)
      ? status.first
      : status.first
        ? [status.first]
        : [];
    if (firstList.length > 0) {
      const targetFirst = firstList.find((f) => {
        if (f.available && !f.done) return true;
        if (signedNow && status.awardIds?.some((a) => a.id === f.awardId))
          return true;
        return false;
      });

      if (targetFirst) {
        const fRes = resourceInfoMap?.[getEntryResourceId(targetFirst)];
        if (fRes) {
          firstRewardName = getRewardText(fRes, getEntryCount(targetFirst));
        }
      }
    }

    return {
      roleId: role.roleId,
      nickname: role.nickname,
      level: role.level,
      hasToday: status.hasToday || signedNow,
      signedNow,
      totalDays,
      calendarTotalDays,
      rewardName,
      rewardIcon,
      yesterdayReward,
      todayReward,
      nextRewards,
      checkedDaysThisMonth,
      missedDaysThisMonth,
      firstRewardName,
      error: !status.hasToday && !signedNow && isClaim,
      message: claimResult?.message,
    };
  } catch (error: any) {
    logger.error(`Error for role ${role.roleId}: ${error.message}`);
    return {
      roleId: role.roleId,
      nickname: role.nickname,
      level: role.level,
      error: true,
      message: error.message,
    };
  }
}
