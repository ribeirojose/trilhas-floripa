# Trilhas de Florianópolis

Mapa aberto e colaborativo das trilhas de Florianópolis e região, alimentado por dados do [OpenStreetMap](https://www.openstreetmap.org).

## Por que OpenStreetMap?

Não duplicamos dados. As trilhas vivem no OSM, onde qualquer pessoa pode adicionar, corrigir e melhorar. Este site é só uma camada de visualização focada em Floripa — mapa, busca e filtros por dificuldade e distância.

## Como funciona

O site é 100% estático e lê `trails.geojson`, um arquivo versionado neste repo.
Nada é consultado em tempo de carregamento — a página abre instantânea e não
depende da Overpass API estar no ar.

`trails.geojson` é gerado por `scripts/refresh.py`, que:

- Baixa da Overpass API os caminhos (`highway=path/footway/track`) e as rotas
  (`route=hiking`) nomeados na caixa da Grande Florianópolis.
- Descarta ruas urbanas que o OSM também marca como calçada: ruas, avenidas,
  servidões, travessas, escadarias, vielas.
- Agrupa segmentos com o mesmo nome em uma trilha só, separando quando dois
  trechos homônimos estão a mais de 4 km um do outro.
- Guarda a geometria real (MultiLineString), então o mapa desenha o traçado da
  trilha, não um pino.
- Calcula a distância somando os segmentos, quando o OSM não informa `distance`.
- Classifica cada trilha em uma região: Norte, Leste, Centro-Oeste, Sul da Ilha
  ou Continente.

### Regiões

| Região | Critério |
| --- | --- |
| Continente | oeste do estreito (lon < -48.56) ou norte da baía |
| Norte da Ilha | lat > -27.50 |
| Leste da Ilha | lon > -48.465 |
| Centro-Oeste da Ilha | entre o Norte e o Sul, a oeste do Leste |
| Sul da Ilha | lat < -27.66 |

Os limites ficam em `region_of()` no `scripts/refresh.py`. Mudou a divisão?
Edite lá e rode `python3 scripts/refresh.py --from-cache` para reclassificar
sem baixar nada do OSM.

## Como contribuir

### 1. Adicionar / corrigir uma trilha

Os dados ficam no OpenStreetMap, não aqui:

1. Crie uma conta em [openstreetmap.org](https://www.openstreetmap.org).
2. Abra o editor em <https://www.openstreetmap.org/edit>.
3. Desenhe ou selecione a trilha e adicione as etiquetas:

| chave | valor | exemplo |
| --- | --- | --- |
| `highway` | `path` ou `footway` | `path` |
| `name` | nome da trilha | `Trilha da Lagoinha do Leste` |
| `sac_scale` | dificuldade | `hiking`, `mountain_hiking`, `demanding_mountain_hiking` |
| `distance` | distância em km | `3.8` |
| `surface` | tipo de piso | `dirt`, `rock`, `sand` |
| `operator` | gestor da trilha | `Parque Estadual do Rio Vermelho` |

4. Salve com uma descrição clara.

### 2. Melhorar este site

```bash
git clone https://github.com/ribeirojose/trilhas-floripa.git
cd trilhas-floripa
python3 -m http.server 8000   # ou qualquer servidor estático
```

Abra <http://localhost:8000>. O site é estático: `index.html`, `app.js` e `style.css`.

Para atualizar os dados depois de editar trilhas no OSM:

```bash
python3 scripts/refresh.py               # baixa do OSM e reescreve trails.geojson
python3 scripts/refresh.py --from-cache  # só reclassifica o arquivo atual
```

A Overpass API às vezes devolve `429`/`502` sob carga — o script sai com erro e
o arquivo antigo permanece intacto. Rode de novo alguns minutos depois.

## Deploy

GitHub Pages (branch `main`, pasta raiz) — sem backend, sem custo.

## Roadmap

- [x] Filtrar ruas/servidões urbanas (não-trilhas) automaticamente
- [x] Desenhar o traçado real da trilha (não só um pino)
- [x] Agrupar trilhas por região da Grande Florianópolis
- [ ] Classificação manual das trilhas oficiais (dificuldade, distância, gestor)
- [ ] Adicionar as trilhas que ainda não existem no OSM
- [ ] Fotos e relatos por trilha (via links para o OSM/Wikimedia)
- [ ] PWA offline para uso na trilha

## Licença

Código: MIT. Dados: © colaboradores do OpenStreetMap, [ODbL](https://www.openstreetmap.org/copyright).
