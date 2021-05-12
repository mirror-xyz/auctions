import chai, { expect } from 'chai';
import asPromised from 'chai-as-promised';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Blockchain } from '../utils/Blockchain';
import {
  MarketFactory,
  MediaFactory,
  ReserveAuctionV4,
  ReserveAuctionV4Factory,
  Media,
  WethFactory,
  EthRejecterFactory,
  EthRejecter,
  EthReceiverFactory,
  EthReceiver,
  ReentrancyAttackerFactory,
  ReentrancyAttacker,
} from '../typechain';
import Decimal from '../utils/Decimal';
import { generatedWallets } from '../utils/generatedWallets';
import { Wallet } from '@ethersproject/wallet';
import { BigNumber, Bytes, ContractTransaction, ethers } from 'ethers';
import { sha256 } from 'ethers/lib/utils';
import { signPermit } from './utils';

chai.use(asPromised);

const provider = new JsonRpcProvider();
const blockchain = new Blockchain(provider);

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

// Test a simple case, as well as some other tricky numbers.
const bidCasesToTest = [
  '2000000000000000000',
  '1234567891234567891',
  '2222222222222222222',
  '3333333333333333333',
  '5555555555555555555',
  '9999999999999999999',
  // Some random bid numbers:
  '158134551011714294',
  '634204952770520617',
  '59188223259592080',
  '17570476732738631',
  '83671249304232044',
  '514248157864491240',
  '63714481580729030',
  '139296974387483490',
  '12715907252298855',
  '977541585289014023',
];

const ERROR_MESSAGES = {
  NOT_OWNER: 'Ownable: caller is not the owner',
  AUCTION_ALREADY_EXISTS: 'Auction already exists',
  AUCTION_DOESNT_EXIST: "Auction doesn't exist",
  INVALID_AMOUNT: "Amount doesn't equal msg.value",
  AUCTION_EXPIRED: 'Auction expired',
  NOT_MIN_BID:
    'Must bid more than last bid by MIN_BID_INCREMENT_PERCENT amount',
  BID_NOT_ZERO: 'Amount must be greater than 0',
  ONLY_AUCTION_CREATOR: 'Can only be called by auction curator',
  AUCTION_ALREADY_STARTED: 'Auction already started',
  AUCTION_HASNT_COMPLETED: "Auction hasn't completed",
  CALLER_NOT_ADMIN: 'Caller does not have admin privileges',
  CURATOR_FEE_TOO_HIGH: 'Curator fee should be < 100',
};

let contentHex: string;
let contentHash: string;
let contentHashBytes: Bytes;
let metadataHex: string;
let metadataHash: string;
let metadataHashBytes: Bytes;

let marketAddress: string;
let mediaAddress: string;
let auctionAddress: string;
let wethAddress: string;
let ethRejecterAddress: string;
let ethReceiverAddress: string;
let reentrancyAttackerAddress: string;

let tokenURI = 'www.example.com';
let metadataURI = 'www.example2.com';

let defaultBidShares = {
  prevOwner: Decimal.new(10),
  owner: Decimal.new(80),
  creator: Decimal.new(10),
};

type DecimalValue = { value: BigNumber };

type BidShares = {
  owner: DecimalValue;
  prevOwner: DecimalValue;
  creator: DecimalValue;
};

type MediaData = {
  tokenURI: string;
  metadataURI: string;
  contentHash: Bytes;
  metadataHash: Bytes;
};

const [
  deployerWallet,
  creatorWallet,
  curatorWallet,
  fundsRecipientWallet,
  firstBidderWallet,
  secondBidderWallet,
  otherWallet,
  adminRecoveryAddress,
] = generatedWallets(provider);

function twoETH(): BigNumber {
  return BigNumber.from(10).pow(18).mul(2);
}

function oneETH(): BigNumber {
  return BigNumber.from(10).pow(18);
}

async function deploy() {
  const market = await (
    await new MarketFactory(deployerWallet).deploy()
  ).deployed();

  marketAddress = market.address;

  const media = await (
    await new MediaFactory(deployerWallet).deploy(marketAddress)
  ).deployed();

  mediaAddress = media.address;

  await market.configure(mediaAddress);

  const weth = await (
    await new WethFactory(deployerWallet).deploy()
  ).deployed();

  wethAddress = weth.address;

  const ethRejecter = await (
    await new EthRejecterFactory(deployerWallet).deploy()
  ).deployed();

  ethRejecterAddress = ethRejecter.address;

  const ethReceiver = await (
    await new EthReceiverFactory(deployerWallet).deploy()
  ).deployed();

  ethReceiverAddress = ethReceiver.address;

  const reentrancyAttacker = await (
    await new ReentrancyAttackerFactory(deployerWallet).deploy()
  ).deployed();

  reentrancyAttackerAddress = reentrancyAttacker.address;

  const auction = await (
    await new ReserveAuctionV4Factory(deployerWallet).deploy(
      mediaAddress,
      wethAddress,
      adminRecoveryAddress.address
    )
  ).deployed();

  auctionAddress = auction.address;
}

async function mediaAs(wallet: Wallet) {
  return MediaFactory.connect(mediaAddress, wallet);
}

async function marketAs(wallet: Wallet) {
  return MarketFactory.connect(marketAddress, wallet);
}

async function wethAs(wallet: Wallet) {
  return WethFactory.connect(wethAddress, wallet);
}

function getAuctionId(contract: string, tokenId: number) {
  const args = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256'],
    [contract, tokenId]
  );
  return ethers.utils.keccak256(args);
}

async function mint(
  zoraMedia: Media,
  metadataURI: string,
  tokenURI: string,
  contentHash: Bytes,
  metadataHash: Bytes,
  shares: BidShares
) {
  const data: MediaData = {
    tokenURI,
    metadataURI,
    contentHash,
    metadataHash,
  };

  return zoraMedia.mint(data, shares);
}

async function mintTokenAs(wallet: Wallet) {
  const zoraMediaAsCreator = await mediaAs(wallet);

  await mint(
    zoraMediaAsCreator,
    metadataURI,
    tokenURI,
    contentHashBytes,
    metadataHashBytes,
    defaultBidShares
  );

  const totalTokens = await zoraMediaAsCreator.balanceOf(creatorWallet.address);

  const lastToken = await zoraMediaAsCreator.tokenOfOwnerByIndex(
    creatorWallet.address,
    totalTokens.sub(1)
  );

  return lastToken;
}

async function auctionAs(wallet: Wallet): Promise<ReserveAuctionV4> {
  return ReserveAuctionV4Factory.connect(auctionAddress, wallet);
}

async function ethRejecterAs(wallet: Wallet): Promise<EthRejecter> {
  return EthRejecterFactory.connect(ethRejecterAddress, wallet);
}

async function ethReceiverAs(wallet: Wallet): Promise<EthReceiver> {
  return EthReceiverFactory.connect(ethReceiverAddress, wallet);
}

async function reentrancyAttackerAs(
  wallet: Wallet
): Promise<ReentrancyAttacker> {
  return ReentrancyAttackerFactory.connect(reentrancyAttackerAddress, wallet);
}

interface IAuctionData {
  tokenId: number;
  reservePrice: BigNumber;
  duration: number;
  curatorFeePercent: number;
  auctionId?: string;
}

async function setupAuctionData(): Promise<IAuctionData> {
  const token = await mintTokenAs(creatorWallet);

  const tokenId = token.toNumber();
  const duration = 60 * 60 * 24; // 24 hours
  const reservePrice = oneETH();
  const curatorFeePercent = 0;
  const auctionId = getAuctionId(mediaAddress, tokenId);
  return {
    tokenId,
    duration,
    curatorFeePercent,
    reservePrice,
    auctionId,
  };
}

async function setupAuction({
  tokenId,
  reservePrice,
  curatorFeePercent,
  duration,
}: IAuctionData): Promise<ContractTransaction> {
  const chainId = 1;
  const auctionAsCurator = await auctionAs(curatorWallet);
  const nftContractAsCreator = await mediaAs(creatorWallet);

  const sig = await signPermit(
    creatorWallet,
    auctionAddress,
    mediaAddress,
    tokenId,
    chainId
  );

  await nftContractAsCreator.permit(auctionAddress, tokenId, sig);

  return auctionAsCurator.createAuction(
    tokenId,
    duration,
    reservePrice,
    curatorFeePercent,
    curatorWallet.address,
    fundsRecipientWallet.address,
    mediaAddress
  );
}

async function resetBlockchain() {
  await blockchain.resetAsync();

  metadataHex = ethers.utils.formatBytes32String('{}');
  metadataHash = await sha256(metadataHex);
  metadataHashBytes = ethers.utils.arrayify(metadataHash);

  contentHex = ethers.utils.formatBytes32String('invert');
  contentHash = await sha256(contentHex);
  contentHashBytes = ethers.utils.arrayify(contentHash);
}

async function getGasAmountFromTx(tx) {
  const txReceipt = await tx.wait();

  const gasUsed = txReceipt.gasUsed;
  const gasPrice = tx.gasPrice;

  return gasUsed.mul(gasPrice);
}

describe('ReserveAuctionV4', () => {
  beforeEach(async () => {
    await deploy();
  });

  describe('#constructor', () => {
    describe('happy path', () => {
      describe('when the passed in address does meet the NFT standard', () => {
        it('should set the variables correctly', async () => {
          const auction = await auctionAs(deployerWallet);
          expect(await auction.zoraContract()).eq(mediaAddress);
          expect(await auction.wethAddress()).eq(wethAddress);
        });
      });
    });
  });

  describe('#createAuction', () => {
    beforeEach(async () => {
      await resetBlockchain();
      await deploy();
    });

    describe('sad path', () => {
      describe('when the auction already exists', () => {
        it('should revert', async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          } = await setupAuctionData();

          await (
            await setupAuction({
              tokenId,
              duration,
              reservePrice,
              curatorFeePercent,
            })
          ).wait();

          const auctionAsCurator = await auctionAs(curatorWallet);

          await expect(
            auctionAsCurator.createAuction(
              tokenId,
              duration,
              reservePrice,
              curatorFeePercent,
              creatorWallet.address,
              fundsRecipientWallet.address,
              mediaAddress
            )
          ).rejectedWith(ERROR_MESSAGES.AUCTION_ALREADY_EXISTS);
        });
      });
    });

    describe('happy path', () => {
      let tx;

      describe('when an auction is created', () => {
        it('should set the attributes correctly', async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          tx = await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const auctionAsCurator = await auctionAs(curatorWallet);
          const auction = await auctionAsCurator.auctions(auctionId);

          expect(auction.reservePrice.toString()).eq(reservePrice.toString());
          expect(auction.duration.toNumber()).eq(duration);
          expect(auction.curator).eq(curatorWallet.address);
          expect(auction.fundsRecipient).eq(fundsRecipientWallet.address);
        });

        // it('should use 201515 gas', async () => {
        //   const receipt = await tx.wait();
        //   const { gasUsed } = receipt;
        //   expect(gasUsed.toString()).to.eq('201515');
        // });

        it('should transfer the NFT to the auction', async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          } = await setupAuctionData();

          const nftContractAsCreator = await mediaAs(creatorWallet);

          const nftOwnerBeforeCreateAuction = await nftContractAsCreator.ownerOf(
            tokenId
          );

          expect(nftOwnerBeforeCreateAuction).eq(creatorWallet.address);

          await setupAuction({
            tokenId,
            duration,
            reservePrice,
            curatorFeePercent,
          });

          const nftOwnerAfterCreateAuction = await nftContractAsCreator.ownerOf(
            tokenId
          );

          expect(nftOwnerAfterCreateAuction).eq(auctionAddress);
        });

        it('should emit the AuctionCreated event', async () => {
          const { tokenId, reservePrice, duration } = await setupAuctionData();

          const tx = await (
            await setupAuction({
              tokenId,
              duration,
              reservePrice,
              curatorFeePercent: 4,
            })
          ).wait();

          const event = tx.events[3];

          const {
            tokenId: tokenIdFromEvent,
            nftContractAddress,
            duration: durationFromEvent,
            reservePrice: reservePriceFromEvent,
            curatorFeePercent: curatorFeePercentFromEvent,
            curator,
            fundsRecipient,
          } = event.args;

          expect(event.event).eq('AuctionCreated');
          expect(tokenIdFromEvent.toNumber()).eq(tokenId);
          expect(nftContractAddress).eq(mediaAddress);
          expect(durationFromEvent.toNumber()).eq(duration);
          expect(reservePriceFromEvent.toString()).eq(reservePrice.toString());
          expect(curator).eq(curatorWallet.address);
          expect(fundsRecipient).eq(fundsRecipientWallet.address);
          expect(curatorFeePercentFromEvent).eq(4);
        });
      });
    });
  });

  describe('#createBid', () => {
    beforeEach(async () => {
      await resetBlockchain();
      await deploy();
    });

    describe('errors', () => {
      describe("when the auction doesn't exist", () => {
        it('should revert', async () => {
          const auctionAsCurator = await auctionAs(curatorWallet);
          const tokenId = 1;
          const amount = oneETH();

          await expect(
            auctionAsCurator.createBid(
              getAuctionId(mediaAddress, tokenId),
              amount,
              { value: oneETH() }
            )
          ).rejectedWith(ERROR_MESSAGES.AUCTION_DOESNT_EXIST);
        });
      });

      describe('when the auction does exist', () => {
        describe("when the amount passed in doesn't equal msg.value", () => {
          it('should revert', async () => {
            const {
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
              auctionId,
            } = await setupAuctionData();

            await setupAuction({
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
            });

            const auctionAsBidder = await auctionAs(firstBidderWallet);

            const twoETHBN = twoETH();

            await expect(
              auctionAsBidder.createBid(auctionId, reservePrice, {
                value: twoETHBN,
              })
            ).rejectedWith(ERROR_MESSAGES.INVALID_AMOUNT);
          });
        });

        describe('when the amount passed in is less than the previous bid amount', () => {
          it('should revert', async () => {
            const {
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
              auctionId,
            } = await setupAuctionData();

            await setupAuction({
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
            });

            const auctionAsFirstBidder = await auctionAs(firstBidderWallet);

            await auctionAsFirstBidder.createBid(auctionId, oneETH(), {
              value: oneETH(),
            });

            const auctionAsSecondBidder = await auctionAs(secondBidderWallet);

            await expect(
              auctionAsSecondBidder.createBid(auctionId, oneETH(), {
                value: oneETH(),
              })
            ).rejectedWith(ERROR_MESSAGES.NOT_MIN_BID);
          });
        });

        describe('when the amount passed in is less than the minBid amount', () => {
          it('should revert', async () => {
            const {
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
              auctionId,
            } = await setupAuctionData();

            await setupAuction({
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
            });

            const auctionAsFirstBidder = await auctionAs(firstBidderWallet);

            await auctionAsFirstBidder.createBid(auctionId, oneETH(), {
              value: oneETH(),
            });

            const auctionAsSecondBidder = await auctionAs(secondBidderWallet);

            const smallAmount = oneETH().add(BigNumber.from(10).mul(10));

            await expect(
              auctionAsSecondBidder.createBid(auctionId, smallAmount, {
                value: smallAmount,
              })
            ).rejectedWith(ERROR_MESSAGES.NOT_MIN_BID);
          });
        });

        describe('when the amount passed in is 0', () => {
          const bidAmount = BigNumber.from('0');
          it('should revert', async () => {
            const {
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
              auctionId,
            } = await setupAuctionData();

            await setupAuction({
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
            });

            const auctionAsFirstBidder = await auctionAs(firstBidderWallet);

            await expect(
              auctionAsFirstBidder.createBid(auctionId, bidAmount, {
                value: bidAmount,
              })
            ).rejectedWith(ERROR_MESSAGES.BID_NOT_ZERO);
          });
        });

        describe('when the auction is over', () => {
          it('should revert', async () => {
            const {
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
              auctionId,
            } = await setupAuctionData();

            await setupAuction({
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
            });

            const auctionAsBidder = await auctionAs(firstBidderWallet);

            await auctionAsBidder.createBid(auctionId, oneETH(), {
              value: oneETH(),
            });

            blockchain.increaseTimeAsync(duration);

            await expect(
              auctionAsBidder.createBid(auctionId, oneETH(), {
                value: oneETH(),
              })
            ).rejectedWith(ERROR_MESSAGES.AUCTION_EXPIRED);
          });
        });
      });
    });

    describe('successful cases', () => {
      describe('when there is an existing bid', () => {
        let tx;

        it('should refund the previous bidder', async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const auctionAsFirstBidder = await auctionAs(firstBidderWallet);

          const originalBalance = await firstBidderWallet.getBalance();

          tx = await auctionAsFirstBidder.createBid(auctionId, oneETH(), {
            value: oneETH(),
          });

          const gasAmount = await getGasAmountFromTx(tx);

          const postBidBalance = await firstBidderWallet.getBalance();

          expect(postBidBalance.toString()).eq(
            originalBalance.sub(gasAmount).sub(oneETH()).toString()
          );

          const auctionAsSecondBidder = await auctionAs(secondBidderWallet);

          tx = await auctionAsSecondBidder.createBid(auctionId, twoETH(), {
            value: twoETH(),
          });

          const currentBalance = await firstBidderWallet.getBalance();

          expect(currentBalance.toString()).eq(
            originalBalance.sub(gasAmount).toString()
          );
        });

        // it('should use 57381 gas', async () => {
        //   const receipt = await tx.wait();
        //   const { gasUsed } = receipt;
        //   expect(gasUsed.toString()).to.eq('57381');
        // });
      });
    });

    describe('when the transaction succeeds', () => {
      let tx;

      it('should set the amount to the last bid', async () => {
        const {
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
          auctionId,
        } = await setupAuctionData();

        await setupAuction({
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
        });

        const auctionAsBidder = await auctionAs(firstBidderWallet);

        tx = await auctionAsBidder.createBid(auctionId, twoETH(), {
          value: twoETH(),
        });

        const auction = await auctionAsBidder.auctions(auctionId);

        expect(auction.amount.toString()).eq(twoETH().toString());
      });

      // it('should cost 94899 gas', async () => {
      //   const receipt = await tx.wait();
      //   const { gasUsed } = receipt;
      //   expect(gasUsed.toString()).to.eq('94899');
      // });

      it('should emit an AuctionBid event', async () => {
        const {
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
          auctionId,
        } = await setupAuctionData();

        await setupAuction({
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
        });

        const auctionAsBidder = await auctionAs(firstBidderWallet);

        const { events } = await (
          await auctionAsBidder.createBid(auctionId, oneETH(), {
            value: oneETH(),
          })
        ).wait();

        const [auctionBidEvent] = events;
        /*
          event AuctionBid(
            bytes32 indexed auctionId,
            address nftContractAddress,
            address sender,
            uint256 value
          );
        */
        expect(auctionBidEvent.event).eq('AuctionBid');
        expect(auctionBidEvent.args.auctionId).eq(auctionId);
        expect(auctionBidEvent.args.nftContractAddress).eq(mediaAddress);
        expect(auctionBidEvent.args.sender).eq(firstBidderWallet.address);
        expect(auctionBidEvent.args.value.toString()).eq(oneETH().toString());
      });
    });
  });

  describe('#cancelAuction', () => {
    beforeEach(async () => {
      await resetBlockchain();
      await deploy();
    });

    describe('sad path', () => {
      describe("when the auction doesn't exist", () => {
        it('should revert', async () => {
          const auctionAsCurator = await auctionAs(curatorWallet);
          await expect(
            auctionAsCurator.cancelAuction(getAuctionId(mediaAddress, 0))
          ).rejectedWith(ERROR_MESSAGES.AUCTION_DOESNT_EXIST);
        });
      });

      describe('when the sender is not the creator', () => {
        it('should revert', async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const auctionAsOther = await auctionAs(otherWallet);

          await expect(auctionAsOther.cancelAuction(auctionId)).rejectedWith(
            ERROR_MESSAGES.ONLY_AUCTION_CREATOR
          );
        });
      });

      describe('when a bid has already been sent', () => {
        it('should revert', async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const auctionAsBidder = await auctionAs(firstBidderWallet);

          await auctionAsBidder.createBid(auctionId, oneETH(), {
            value: oneETH(),
          });

          const auctionAsCurator = await auctionAs(curatorWallet);

          await expect(auctionAsCurator.cancelAuction(auctionId)).rejectedWith(
            ERROR_MESSAGES.AUCTION_ALREADY_STARTED
          );
        });
      });
    });

    describe('happy path', () => {
      it('should delete the auction', async () => {
        const {
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
          auctionId,
        } = await setupAuctionData();

        await setupAuction({
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
        });

        const auctionAsCurator = await auctionAs(curatorWallet);
        await auctionAsCurator.cancelAuction(auctionId);
        const auction = await auctionAsCurator.auctions(auctionId);
        expect(auction.curator).eq(NULL_ADDRESS);
      });

      it('should transfer the NFT back to the creator', async () => {
        const {
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
          auctionId,
        } = await setupAuctionData();

        const nftContractAsCreator = await mediaAs(creatorWallet);

        const nftOwnerBeforeCreateAuction = await nftContractAsCreator.ownerOf(
          tokenId
        );

        expect(nftOwnerBeforeCreateAuction).eq(creatorWallet.address);

        await setupAuction({
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
        });

        const nftOwnerAfterCreateAuction = await nftContractAsCreator.ownerOf(
          tokenId
        );

        expect(nftOwnerAfterCreateAuction).eq(auctionAddress);

        const auctionAsCurator = await auctionAs(curatorWallet);

        await auctionAsCurator.cancelAuction(auctionId);

        const nftOwnerAfterCancelAuction = await nftContractAsCreator.ownerOf(
          tokenId
        );

        expect(nftOwnerAfterCancelAuction).eq(curatorWallet.address);
      });

      it('should emit the AuctionCanceled event', async () => {
        const {
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
          auctionId,
        } = await setupAuctionData();

        await setupAuction({
          tokenId,
          reservePrice,
          duration,
          curatorFeePercent,
        });

        const auctionAsCurator = await auctionAs(curatorWallet);

        const { events } = await (
          await auctionAsCurator.cancelAuction(auctionId)
        ).wait();

        const auctionCanceledEvent = events[3];
        /*
          event AuctionCanceled(
            bytes32 indexed auctionId,
            address nftContractAddress,
            address curator
          );
        */
        expect(auctionCanceledEvent.event).eq('AuctionCanceled');
        expect(auctionCanceledEvent.args.auctionId).eq(auctionId);
        expect(auctionCanceledEvent.args.nftContractAddress).eq(mediaAddress);
        expect(auctionCanceledEvent.args.curator).eq(curatorWallet.address);
      });
    });
  });

  /*
    Admin Functions
  */

  describe('admin function', () => {
    beforeEach(async () => {
      await resetBlockchain();
      await deploy();
    });

    let balanceBefore;
    let auctionAsCurator;
    let nftId;

    beforeEach(async () => {
      const {
        tokenId,
        reservePrice,
        duration,
        curatorFeePercent,
        auctionId,
      } = await setupAuctionData();
      nftId = tokenId;

      await setupAuction({
        tokenId,
        reservePrice,
        duration,
        curatorFeePercent,
      });

      auctionAsCurator = await auctionAs(curatorWallet);

      const tx = await auctionAsCurator.createBid(auctionId, twoETH(), {
        value: twoETH(),
      });

      await tx.wait();

      balanceBefore = await provider.getBalance(auctionAsCurator.address);
    });

    describe('#transferETH', () => {
      describe('when called by a random address', () => {
        it('reverts', async () => {
          // Sanity check that balance before is 2 ETH.
          expect(balanceBefore.toString()).to.eq(twoETH().toString());

          const tx = auctionAsCurator.recoverETH(twoETH());
          // Transaction should revert.
          await expect(tx).rejectedWith(ERROR_MESSAGES.CALLER_NOT_ADMIN);

          // Balance should be unchanged.
          const balanceAfter = await provider.getBalance(
            auctionAsCurator.address
          );
          expect(balanceAfter.toString()).to.eq(balanceBefore.toString());
        });
      });

      describe('when called by the admin recovery address', () => {
        let gasAmount;
        let adminBalanceBefore;

        beforeEach(async () => {
          adminBalanceBefore = await provider.getBalance(
            adminRecoveryAddress.address
          );

          const auctionAsAdmin = await auctionAs(adminRecoveryAddress);
          const tx = await auctionAsAdmin.recoverETH(twoETH());
          // Transaction should complete.
          await tx.wait();

          gasAmount = await getGasAmountFromTx(tx);
        });

        it('decreases ETH in the auction contract to 0', async () => {
          // Sanity check that balance before is 2 ETH.
          expect(balanceBefore.toString()).to.eq(twoETH().toString());
          // Balance afterwards should be zero.
          const balanceAfter = await provider.getBalance(
            auctionAsCurator.address
          );
          expect(balanceAfter.toString()).to.eq('0');
        });

        it('increases the ETH balance in the recovery address', async () => {
          // Balance should be transferred to the admin.
          const adminBalance = await provider.getBalance(
            adminRecoveryAddress.address
          );
          expect(
            // The amount that got added is equal to the current balance, minus
            // the original balance, plus thas gas used.
            adminBalance.sub(adminBalanceBefore).add(gasAmount).toString()
          ).to.eq(balanceBefore.toString());
        });
      });

      describe('turnOffAdminRecovery', () => {
        describe('when called by a random address', () => {
          it('reverts', async () => {
            const auctionAsAdmin = await auctionAs(adminRecoveryAddress);
            const adminRecovery = await auctionAsAdmin.adminRecoveryEnabled();
            expect(adminRecovery).to.eq(true);

            const badTx = auctionAsCurator.turnOffAdminRecovery();
            // Transaction should revert.
            await expect(badTx).rejectedWith(ERROR_MESSAGES.CALLER_NOT_ADMIN);
          });
        });

        describe('when called by admin', () => {
          it('sets adminRecovery to false', async () => {
            const auctionAsAdmin = await auctionAs(adminRecoveryAddress);
            await await auctionAsAdmin.turnOffAdminRecovery();

            const adminRecovery = await auctionAsAdmin.adminRecoveryEnabled();
            expect(adminRecovery).to.eq(false);
          });

          it('prevents all admin actions being called', async () => {
            const auctionAsAdmin = await auctionAs(adminRecoveryAddress);
            await await auctionAsAdmin.turnOffAdminRecovery();

            const tx = auctionAsAdmin.recoverETH(twoETH());
            // Transaction should revert even when called by admin,
            // because admin is turned off.
            await expect(tx).rejectedWith(ERROR_MESSAGES.CALLER_NOT_ADMIN);
          });
        });
      });
    });

    describe('#transferNFT', () => {
      describe('when called by a random address', () => {
        it('reverts', async () => {
          const auctionId = getAuctionId(mediaAddress, nftId);
          // Sanity check ownership of NFT is the auction.
          const zoraMediaAsCreator = await mediaAs(creatorWallet);
          const ownerBefore = await zoraMediaAsCreator.ownerOf(nftId);
          expect(ownerBefore).to.eq(auctionAsCurator.address);

          const tx = auctionAsCurator.recoverNFT(auctionId);
          // Transaction should revert.
          await expect(tx).rejectedWith(ERROR_MESSAGES.CALLER_NOT_ADMIN);

          // Ownership should be unchanged.
          const ownerAfter = await zoraMediaAsCreator.ownerOf(nftId);
          expect(ownerAfter).to.eq(auctionAsCurator.address);
        });
      });

      describe('when called by the admin recovery address', () => {
        it('transfers the NFT', async () => {
          const auctionId = getAuctionId(mediaAddress, nftId);
          // Sanity check ownership of NFT is the auction.
          const zoraMediaAsCreator = await mediaAs(adminRecoveryAddress);
          const ownerBefore = await zoraMediaAsCreator.ownerOf(nftId);
          expect(ownerBefore).to.eq(auctionAsCurator.address);

          const auctionAsAdmin = await auctionAs(adminRecoveryAddress);
          const tx = await auctionAsAdmin.recoverNFT(auctionId);
          // Transaction should complete.
          await tx.wait();

          // Ownership should be updated to the admin recovery account.
          const ownerAfter = await zoraMediaAsCreator.ownerOf(nftId);
          expect(ownerAfter).to.eq(adminRecoveryAddress.address);
        });
      });
    });
  });

  describe('#endAuction', () => {
    beforeEach(async () => {
      await resetBlockchain();
      await deploy();
    });

    describe('sad path', () => {
      describe("when ending an auction that doesn't exist", () => {
        it('should revert', async () => {
          const auctionAsCurator = await auctionAs(curatorWallet);
          await expect(
            auctionAsCurator.endAuction(getAuctionId(mediaAddress, 100))
          ).rejectedWith(ERROR_MESSAGES.AUCTION_HASNT_COMPLETED);
        });
      });

      describe("when ending an auction that hasn't begun", () => {
        it('should revert', async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const auctionAsCurator = await auctionAs(curatorWallet);

          await expect(auctionAsCurator.endAuction(auctionId)).rejectedWith(
            ERROR_MESSAGES.AUCTION_HASNT_COMPLETED
          );
        });
      });

      describe("when ending an auction that hasn't completed", () => {
        it('should revert', async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const auctionAsBidder = await auctionAs(firstBidderWallet);

          const tx = await auctionAsBidder.createBid(auctionId, twoETH(), {
            value: twoETH(),
          });

          await tx.wait();

          await expect(auctionAsBidder.endAuction(auctionId)).rejectedWith(
            ERROR_MESSAGES.AUCTION_HASNT_COMPLETED
          );
        });
      });
    });

    describe('after a valid auction', () => {
      for (let i = 0; i < bidCasesToTest.length; i++) {
        const bidAmount = bidCasesToTest[i];

        describe(`when there was one bidder with a bid of ${ethers.utils.formatEther(
          bidAmount
        )} ETH`, () => {
          let nftOwnerBeforeEndAuction,
            nftOwnerAfterEndAuction,
            auctionBeforeEndAuction,
            auctionAfterEndAuction,
            beforeCreatorBalance,
            afterCreatorBalance,
            beforeFundsRecipientBalance,
            afterFundsRecipientBalance,
            creatorAmount;
          let receipt;

          beforeEach(async () => {
            const {
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
              auctionId,
            } = await setupAuctionData();

            await setupAuction({
              tokenId,
              // Absurdly low reserve price, since that's not what we're testing.
              reservePrice: BigNumber.from('1'),
              duration,
              curatorFeePercent,
            });

            const auctionAsBidder = await auctionAs(firstBidderWallet);

            let tx = await auctionAsBidder.createBid(auctionId, bidAmount, {
              value: bidAmount,
            });

            await tx.wait();
            await blockchain.increaseTimeAsync(duration);

            const nftContractAsCreator = await mediaAs(creatorWallet);

            nftOwnerBeforeEndAuction = await nftContractAsCreator.ownerOf(
              tokenId
            );

            auctionBeforeEndAuction = await auctionAsBidder.auctions(auctionId);
            beforeCreatorBalance = await creatorWallet.getBalance();
            beforeFundsRecipientBalance = await fundsRecipientWallet.getBalance();

            const market = await marketAs(creatorWallet);
            const creatorShare = await market.bidSharesForToken(tokenId);

            creatorAmount = await market.splitShare(
              creatorShare.creator,
              bidAmount
            );

            const endAuctionTx = await auctionAsBidder.endAuction(auctionId);
            receipt = await endAuctionTx.wait();

            nftOwnerAfterEndAuction = await nftContractAsCreator.ownerOf(
              tokenId
            );
            auctionAfterEndAuction = await auctionAsBidder.auctions(auctionId);
            afterCreatorBalance = await creatorWallet.getBalance();
            afterFundsRecipientBalance = await fundsRecipientWallet.getBalance();
          });

          it('should delete the auction', () => {
            expect(auctionBeforeEndAuction.curator).eq(curatorWallet.address);
            expect(auctionAfterEndAuction.curator).eq(NULL_ADDRESS);
          });

          it('should transfer the NFT from the auction to the winning bidder', () => {
            expect(nftOwnerBeforeEndAuction).eq(auctionAddress);
            expect(nftOwnerAfterEndAuction).eq(firstBidderWallet.address);
          });

          it(`should send the creator to the original creator`, () => {
            expect(afterCreatorBalance.toString()).eq(
              beforeCreatorBalance.add(creatorAmount).toString()
            );
          });

          it(`should send the rest of the bid amount to the funds recipient`, () => {
            expect(afterFundsRecipientBalance.toString()).eq(
              beforeFundsRecipientBalance
                .add(bidAmount)
                .sub(creatorAmount)
                .toString()
            );
          });

          // it('should cost 107932 gas', () => {
          //   const { gasUsed } = receipt;
          //   expect(gasUsed.toString()).to.eq('107932');
          // });
        });
      }

      describe('when there is a 100 percent curator fee', () => {
        it('reverts with error "Curator fee should be < 100"', async () => {
          const { tokenId, reservePrice, duration } = await setupAuctionData();

          await expect(
            setupAuction({
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent: 100,
            })
          ).rejectedWith(ERROR_MESSAGES.CURATOR_FEE_TOO_HIGH);
        });
      });

      describe('when there is a 5 percent curator fee', () => {
        let nftOwnerBeforeEndAuction,
          nftOwnerAfterEndAuction,
          auctionBeforeEndAuction,
          auctionAfterEndAuction,
          beforeCuratorBalance,
          afterCuratorBalance,
          beforeCreatorBalance,
          afterCreatorBalance,
          beforeFundsRecipientBalance,
          afterFundsRecipientBalance,
          curatorAmount,
          creatorAmount;
        let receipt;

        beforeEach(async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent: 5,
          });

          const auctionAsBidder = await auctionAs(firstBidderWallet);

          let tx = await auctionAsBidder.createBid(auctionId, twoETH(), {
            value: twoETH(),
          });

          await tx.wait();
          await blockchain.increaseTimeAsync(duration);

          const nftContractAsCreator = await mediaAs(creatorWallet);

          nftOwnerBeforeEndAuction = await nftContractAsCreator.ownerOf(
            tokenId
          );

          auctionBeforeEndAuction = await auctionAsBidder.auctions(auctionId);
          beforeCreatorBalance = await creatorWallet.getBalance();
          beforeCuratorBalance = await curatorWallet.getBalance();
          beforeFundsRecipientBalance = await fundsRecipientWallet.getBalance();

          const market = await marketAs(creatorWallet);
          const creatorShare = await market.bidSharesForToken(tokenId);

          curatorAmount = twoETH().div(100).mul(5);
          creatorAmount = await market.splitShare(
            creatorShare.creator,
            twoETH().sub(curatorAmount)
          );

          const endAuctionTx = await auctionAsBidder.endAuction(auctionId);
          receipt = await endAuctionTx.wait();

          nftOwnerAfterEndAuction = await nftContractAsCreator.ownerOf(tokenId);
          auctionAfterEndAuction = await auctionAsBidder.auctions(auctionId);
          afterCreatorBalance = await creatorWallet.getBalance();
          afterCuratorBalance = await curatorWallet.getBalance();
          afterFundsRecipientBalance = await fundsRecipientWallet.getBalance();
        });

        it('should delete the auction', () => {
          expect(auctionBeforeEndAuction.curator).eq(curatorWallet.address);
          expect(auctionAfterEndAuction.curator).eq(NULL_ADDRESS);
        });

        it('should transfer the NFT from the auction to the winning bidder', () => {
          expect(nftOwnerBeforeEndAuction).eq(auctionAddress);
          expect(nftOwnerAfterEndAuction).eq(firstBidderWallet.address);
        });

        it('should send 5% of the amount to the curator address', () => {
          expect(afterCuratorBalance.toString()).eq(
            beforeCuratorBalance.add(curatorAmount).toString()
          );
        });

        it('should send the creator share to the original creator', () => {
          expect(afterCreatorBalance.toString()).eq(
            beforeCreatorBalance.add(creatorAmount).toString()
          );
        });

        it('should send the rest of the bid amount to the funds recipient', () => {
          const amountReceived = twoETH().sub(curatorAmount).sub(creatorAmount);
          const amountWithoutFee = beforeFundsRecipientBalance
            .add(amountReceived)
            .toString();

          expect(afterFundsRecipientBalance.toString()).eq(amountWithoutFee);
        });

        // it('should cost 112913 gas', () => {
        //   const { gasUsed } = receipt;
        //   expect(gasUsed.toString()).to.eq('112913');
        // });
      });

      for (let i = 0; i < bidCasesToTest.length; i++) {
        const firstBidAmount = bidCasesToTest[i];
        const secondBidAmount = BigNumber.from(firstBidAmount)
          .mul(2)
          .toString();

        describe(`when there were two bidders, bidding ${ethers.utils.formatEther(
          firstBidAmount
        )} and then ${ethers.utils.formatEther(secondBidAmount)} ETH`, () => {
          let nftOwnerBeforeEndAuction,
            nftOwnerAfterEndAuction,
            postBidBalance,
            originalBalance,
            gasAmount;

          beforeEach(async () => {
            const {
              tokenId,
              reservePrice,
              duration,
              curatorFeePercent,
              auctionId,
            } = await setupAuctionData();

            await setupAuction({
              tokenId,
              // Not testing reserve price here, so we'll keep it low.
              reservePrice: BigNumber.from('1'),
              duration,
              curatorFeePercent,
            });

            const auctionAsFirstBidder = await auctionAs(firstBidderWallet);
            const auctionAsSecondBidder = await auctionAs(secondBidderWallet);

            originalBalance = await firstBidderWallet.getBalance();

            let tx = await auctionAsFirstBidder.createBid(
              auctionId,
              firstBidAmount,
              {
                value: firstBidAmount,
              }
            );
            await tx.wait();

            gasAmount = await getGasAmountFromTx(tx);

            postBidBalance = await firstBidderWallet.getBalance();

            tx = await auctionAsSecondBidder.createBid(
              auctionId,
              secondBidAmount,
              {
                value: secondBidAmount,
              }
            );
            await tx.wait();

            await blockchain.increaseTimeAsync(duration);

            const nftContractAsCreator = await mediaAs(creatorWallet);

            nftOwnerBeforeEndAuction = await nftContractAsCreator.ownerOf(
              tokenId
            );

            tx = await auctionAsSecondBidder.endAuction(auctionId);
            tx.wait();

            nftOwnerAfterEndAuction = await nftContractAsCreator.ownerOf(
              tokenId
            );
          });

          it('should send the NFT to the second bidder', () => {
            expect(nftOwnerBeforeEndAuction).eq(auctionAddress);
            expect(nftOwnerAfterEndAuction).eq(secondBidderWallet.address);
          });

          it('should refund the first bidder', async () => {
            expect(postBidBalance.toString()).eq(
              originalBalance.sub(gasAmount).sub(firstBidAmount).toString()
            );

            const currentBalance = await firstBidderWallet.getBalance();

            expect(currentBalance.toString()).eq(
              originalBalance.sub(gasAmount).toString()
            );
          });
        });
      }

      describe('when the first bidder is a contract that rejects ETH and is outbid', () => {
        let receipt;

        beforeEach(async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const rejecter = await ethRejecterAs(firstBidderWallet);
          const auctionAsSecondBidder = await auctionAs(secondBidderWallet);

          let tx = await rejecter.relayBid(
            auctionAddress,
            auctionId,
            oneETH(),
            {
              value: oneETH(),
            }
          );

          await tx.wait();

          tx = await auctionAsSecondBidder.createBid(auctionId, twoETH(), {
            value: twoETH(),
          });
          receipt = await tx.wait();
        });

        it("returns the contract's ETH back in WETH", async () => {
          const balance = await provider.getBalance(ethRejecterAddress);
          expect(balance.toString()).to.eq('0');

          const wethAsBidder = wethAs(firstBidderWallet);
          const contractWethBalance = (await wethAsBidder).balanceOf(
            ethRejecterAddress
          );

          expect((await contractWethBalance).toString()).to.eq(
            oneETH().toString()
          );
        });

        // it('should cost 129055 gas', () => {
        //   const { gasUsed } = receipt;
        //   expect(gasUsed.toString()).to.eq('129055');
        // });
      });

      describe('when the first bidder is a contract that accepts ETH but uses more gas', () => {
        let receipt;

        beforeEach(async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const receiver = await ethReceiverAs(firstBidderWallet);
          const auctionAsSecondBidder = await auctionAs(secondBidderWallet);

          let tx = await receiver.relayBid(
            auctionAddress,
            auctionId,
            oneETH(),
            {
              value: oneETH(),
            }
          );

          await tx.wait();

          tx = await auctionAsSecondBidder.createBid(auctionId, twoETH(), {
            value: twoETH(),
          });
          receipt = await tx.wait();
        });

        it("returns the contract's ETH back in ETH", async () => {
          const balance = await provider.getBalance(ethReceiverAddress);
          expect(balance.toString()).to.eq(oneETH().toString());

          const wethAsBidder = wethAs(firstBidderWallet);
          const contractWethBalance = (await wethAsBidder).balanceOf(
            ethReceiverAddress
          );

          expect((await contractWethBalance).toString()).to.eq('0');
        });

        // it('should cost 81642 gas', () => {
        //   const { gasUsed } = receipt;
        //   expect(gasUsed.toString()).to.eq('81642');
        // });
      });

      describe('when the first bidder is a contract that attempts reentrancy', () => {
        let receipt;

        beforeEach(async () => {
          const {
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
            auctionId,
          } = await setupAuctionData();

          await setupAuction({
            tokenId,
            reservePrice,
            duration,
            curatorFeePercent,
          });

          const attacker = await reentrancyAttackerAs(firstBidderWallet);
          const auctionAsSecondBidder = await auctionAs(secondBidderWallet);

          let tx = await attacker.relayBid(
            auctionAddress,
            auctionId,
            oneETH(),
            {
              value: oneETH(),
            }
          );

          await tx.wait();

          tx = await auctionAsSecondBidder.createBid(auctionId, twoETH(), {
            value: twoETH(),
          });
          receipt = await tx.wait();
        });

        it("returns the contract's ETH back in WETH", async () => {
          const balance = await provider.getBalance(reentrancyAttackerAddress);
          expect(balance.toString()).to.eq('0');

          const wethAsBidder = wethAs(firstBidderWallet);
          const contractWethBalance = (await wethAsBidder).balanceOf(
            reentrancyAttackerAddress
          );

          expect((await contractWethBalance).toString()).to.eq(
            oneETH().toString()
          );
        });

        // it('should cost 106468 gas', () => {
        //   const { gasUsed } = receipt;
        //   expect(gasUsed.toString()).to.eq('106468');
        // });
      });
    });
  });
});
