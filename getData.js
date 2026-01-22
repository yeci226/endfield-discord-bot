import axios from "axios";

const URL = "https://zonai.skport.com/api/v1/game/endfield/card/detail";

const params = {
  roleId: "4494008723",
  serverId: "2",
  userId: "8911159310760",
};

const headers = {
  cred: "nm3M9cPq1rto0oz6DPG2NXlEssucGe89",
  "sk-language": "zh_Hant",
};

async function main() {
  try {
    const resp = await axios.get(URL, {
      params,
      headers,
    });
  } catch (error) {
    console.error(error);
  }
}

main();
