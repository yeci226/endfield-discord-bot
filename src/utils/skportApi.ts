import axios from "axios";

/**
 * Formats the Skport Language header based on Discord locale
 * @param locale Discord interaction locale
 * @returns Skport language code (e.g., 'zh_Hant')
 */
export function formatSkLanguage(locale?: string): string {
  const base = locale || "zh-TW";
  if (base === "zh-TW" || base === "zh-HK") return "zh_Hant";
  if (base === "zh-CN") return "zh_Hans";
  return "en_US";
}

/**
 * Formats the Accept-Language header based on Discord locale
 * @param locale Discord interaction locale (e.g., 'zh-TW', 'en-US')
 * @returns Formatted Accept-Language string
 */
export function formatAcceptLanguage(locale?: string): string {
  const base = locale || "zh-TW";
  if (base.startsWith("zh")) {
    return "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6";
  }
  return `${base},en;q=0.9`;
}

export async function verifyCookie(cookie: string, locale?: string) {
  const url = "https://zonai.skport.com/web/v2/user";

  // Default headers from request
  const headers = {
    authority: "zonai.skport.com",
    accept: "*/*",
    "accept-language": formatAcceptLanguage(locale),
    "content-type": "application/json",
    cred: "HmGa3FL1u3S3T0ZWbBHjd1KbBP1nElR5",
    origin: "https://www.skport.com",
    platform: "3",
    referer: "https://www.skport.com/",
    sign: "ce0e9f569220bc834eab6d7637119e09",
    "sk-language": formatSkLanguage(locale),
    vname: "1.0.0",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Cookie: cookie,
  };

  try {
    const response = await axios.get(url, { headers });
    return response.data;
  } catch (error) {
    console.error("Error verifying cookie:", error);
    return null;
  }
}

export async function getCharacterPool(locale?: string) {
  const url = "https://zonai.skport.com/web/v1/wiki/char-pool";
  const headers = {
    authority: "zonai.skport.com",
    accept: "*/*",
    "accept-language": formatAcceptLanguage(locale),
    "content-type": "application/json",
    cred: "HmGa3FL1u3S3T0ZWbBHjd1KbBP1nElR5",
    origin: "https://www.skport.com",
    platform: "3",
    referer: "https://wiki.skport.com/",
    sign: "df10a1a3392f6c87e3941ad9a5783834",
    "sk-language": formatSkLanguage(locale),
    vname: "1.0.0",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  };

  try {
    const response = await axios.get(url, { headers });
    return response.data;
  } catch (error) {
    console.error("Error fetching character pool:", error);
    return null;
  }
}

export async function getWeaponPool(locale?: string) {
  const url = "https://zonai.skport.com/web/v1/wiki/weapon-pool";
  const headers = {
    authority: "zonai.skport.com",
    accept: "*/*",
    "accept-language": formatAcceptLanguage(locale),
    "content-type": "application/json",
    cred: "HmGa3FL1u3S3T0ZWbBHjd1KbBP1nElR5",
    origin: "https://www.skport.com",
    platform: "3",
    referer: "https://wiki.skport.com/",
    sign: "247688e66256a8e71fccf07b7342696e",
    "sk-language": formatSkLanguage(locale),
    vname: "1.0.0",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  };

  try {
    const response = await axios.get(url, { headers });
    return response.data;
  } catch (error) {
    console.error("Error fetching weapon pool:", error);
    return null;
  }
}

export async function getWikiCatalog(
  locale?: string,
  typeMainId: string = "",
  typeSubId: string = "",
) {
  const url = "https://zonai.skport.com/web/v1/wiki/item/catalog";
  const headers = {
    accept: "*/*",
    "accept-language": formatAcceptLanguage(locale),
    "content-type": "application/json",
    cred: "HmGa3FL1u3S3T0ZWbBHjd1KbBP1nElR5",
    platform: "3",
    priority: "u=1, i",
    "sec-ch-ua":
      '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    sign: "beaa4eec5233d4c2de149f85d6fbeee0",
    "sk-language": formatSkLanguage(locale),
    timestamp: "1768988164",
    vname: "1.0.0",
    Referer: "https://wiki.skport.com/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  };

  try {
    const response = await axios.get(url, {
      headers,
      params: {
        typeMainId,
        typeSubId,
      },
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching wiki catalog:", error);
    return null;
  }
}

export async function getWikiItemDetail(id: number | string, locale?: string) {
  const url = "https://zonai.skport.com/web/v1/wiki/item/info";
  const headers = {
    accept: "*/*",
    "accept-language": formatAcceptLanguage(locale),
    "content-type": "application/json",
    cred: "HmGa3FL1u3S3T0ZWbBHjd1KbBP1nElR5",
    platform: "3",
    priority: "u=1, i",
    "sec-ch-ua":
      '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    sign: "e144167a879fba3b2c5d6eb063a9c5fe",
    "sk-language": formatSkLanguage(locale),
    timestamp: "1768988662",
    vname: "1.0.0",
    Referer: "https://wiki.skport.com/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  };

  try {
    const response = await axios.get(url, {
      headers,
      params: { id },
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching wiki item detail:", error);
    return null;
  }
}
