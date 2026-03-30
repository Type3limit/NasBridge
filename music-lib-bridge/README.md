# music-lib

music-lib 是个用 Go 写的音乐库。

它没有 UI，主要帮你解决各个音乐平台的数据接口问题——不管是搜索、解析还是下载。如果你想自己写个音乐下载器或者播放器，用它正好。

## 主要功能

支持网易云、QQ、酷狗、酷我这些主流平台，也能搞定汽水音乐、5sing 这些。具体支持情况如下：

| 平台       | 包名         | 搜索 | 下载 | 歌词 | 歌曲解析 | 歌单搜索 | 歌单推荐 | 歌单歌曲 | 歌单链接解析 | 备注           |
| :--------- | :----------- | :--: | :--: | :--: | :------: | :------: | :------: | :------: | :----------: | :------------- |
| 网易云音乐 | `netease`  |  ✅  |  ✅  |  ✅  |    ✅    |    ✅    |    ✅    |    ✅    |      ✅      | 支持 FLAC 无损 |
| QQ 音乐    | `qq`       |  ✅  |  ✅  |  ✅  |    ✅    |    ✅    |    ✅    |    ✅    |      ✅      | 支持 FLAC 无损 |
| 酷狗音乐   | `kugou`    |  ✅  |  ✅  |  ✅  |    ✅    |    ✅    |    ✅    |    ✅    |      ✅      | 支持普通歌曲 FLAC 无损 |
| 酷我音乐   | `kuwo`     |  ✅  |  ✅  |  ✅  |    ✅    |    ✅    |    ✅    |    ✅    |      ✅      |                |
| 咪咕音乐   | `migu`     |  ✅  |  ✅  |  ✅  |    ❌    |    ✅    |    ❌    |    ❌    |      ❌      |                |
| 千千音乐   | `qianqian` |  ✅  |  ✅  |  ✅  |    ❌    |    ❌    |    ❌    |    ✅    |      ❌      |                |
| 汽水音乐   | `soda`     |  ✅  |  ✅  |  ✅  |    ✅    |    ✅    |    ❌    |    ✅    |      ✅      | 音频解密       |
| 5sing      | `fivesing` |  ✅  |  ✅  |  ✅  |    ✅    |    ✅    |    ❌    |    ✅    |      ✅      |                |
| Jamendo    | `jamendo`  |  ✅  |  ✅  |  ❌  |    ✅    |    ❌    |    ❌    |    ❌    |      ❌      |                |
| JOOX       | `joox`     |  ✅  |  ✅  |  ✅  |    ❌    |    ✅    |    ❌    |    ❌    |      ❌      |                |
| Bilibili   | `bilibili` |  ✅  |  ✅  |  ❌  |    ✅    |    ✅    |    ❌    |    ✅    |      ✅      | 支持 FLAC 无损 |

## 怎么用

直接 `go get`：

```bash
go get github.com/guohuiyuan/music-lib
```

## HTTP bridge 的 cookie 配置

这个仓库里的 `main.go` 可以直接跑成一个 HTTP bridge，给 NAS 的 `storage-client` 调用。

bridge 启动时会按下面两种方式读取 cookie：

1. 优先读取当前进程环境变量。
2. 如果工作目录下存在 `.env`，会自动补充读取其中还没有注入到环境里的变量。

当前 bridge 识别这些变量：

```env
NETEASE_COOKIE=
QQ_COOKIE=
KUGOU_COOKIE=
KUWO_COOKIE=
BILIBILI_COOKIE=
```

如果你是通过 NAS 的 `storage-client` 启动 bridge，最简单的做法是把这些变量放到 `storage-client` 使用的 `.env` 里。因为 `storage-client` 启动时会先加载 dotenv，然后把环境变量原样透传给 `music-lib-bridge` 子进程。

如果你是单独启动 `music-lib-bridge`，可以直接把 `.env.example` 复制成 `.env`，填好 cookie 后在 `music-lib-bridge` 目录里执行：

```bash
go run .
```

### QQ VIP 如何配置

`QQ_COOKIE` 需要填浏览器里登录 QQ 音乐后的整段 Cookie，至少建议包含这些字段：

- `uin`
- `qqmusic_key`
- `qm_keyst`
- `qqmusic_fromtag`

推荐做法：

1. 在浏览器里打开 `https://y.qq.com` 并登录开通了绿钻的账号。
2. 打开开发者工具，找到任意 `y.qq.com` 请求的 `Cookie` 请求头。
3. 复制完整 Cookie 字符串，写入 `QQ_COOKIE=` 后面。
4. 重启 `storage-client` 或 bridge 进程。

有了有效的 `QQ_COOKIE` 后，bridge 在解析 QQ 曲目播放地址时会使用带登录态的 provider 实例，VIP 曲目命中率会明显高于匿名请求。

### Kugou / Kuwo

`KUGOU_COOKIE` 和 `KUWO_COOKIE` 的配置方式相同：

1. 分别登录对应站点。
2. 从浏览器请求头复制完整 Cookie。
3. 写入 `.env` 或宿主进程环境变量。
4. 重启 bridge。

注意：cookie 只能提高 VIP 或高音质接口的可用率，不能保证所有版权受限歌曲都一定能返回可播放地址。

### 1. 搜歌 + 下载

```go
package main

import (
	"fmt"
	"log"

	"github.com/guohuiyuan/music-lib/kugou"
)

func main() {
	songs, err := kugou.Search("周杰伦")
	if err != nil {
		log.Fatal(err)
	}
	if len(songs) == 0 {
		fmt.Println("没找到相关歌曲")
		return
	}

	// 拿第一首的下载地址
	url, err := kugou.GetDownloadURL(&songs[0])
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("下载地址:", url)
}
```

### 2. 获取推荐歌单 (新功能)

```go
package main

import (
	"fmt"
	"log"
	"github.com/guohuiyuan/music-lib/netease"
)

func main() {
	// 获取不需要登录的推荐歌单
	playlists, err := netease.GetRecommendedPlaylists()
	if err != nil {
		log.Fatal(err)
	}

	fmt.Printf("拿到 %d 个推荐歌单：\n", len(playlists))
	for _, p := range playlists {
		fmt.Printf("- %s (ID: %s)\n", p.Name, p.ID)
	}
}
```

### 3. 解析歌单链接

```go
package main

import (
	"fmt"
	"log"
	"github.com/guohuiyuan/music-lib/netease"
)

func main() {
	link := "https://music.163.com/#/playlist?id=123456"
	playlist, songs, err := netease.ParsePlaylist(link)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%s 共有 %d 首歌\n", playlist.Name, len(songs))
}
```

## 设计的一点想法

做这个库的时候，我尽量保证了**独立性**和**统一性**。

- **独立性**：你可以只引 `netease` 包，别的包不会进去污染你的依赖。
- **统一性**：不管用哪个包，返回的 `Song` 和 `Playlist` 结构都是一样的，切换源的时候不用改业务逻辑。
- **扩展性**：如果要加新平台，照着 `provider` 接口实现一遍就行。

## 目录结构

```
music-lib/
├── model/      # 都在用的数据结构
├── provider/   # 接口定义
├── netease/    # 各个平台的实现
├── qq/
├── kugou/
...
└── README.md
```

## 许可证

本项目遵循 GNU Affero General Public License v3.0（AGPL-3.0）。详情见 [LICENSE](LICENSE)。

## 免责声明

这个库就是写着玩、学技术的。大家用的时候遵守一下法律法规，不要拿去商用。下载的资源 24 小时内删掉。
